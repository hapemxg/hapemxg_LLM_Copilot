import {
    sessions, currentSessionId, isGenerating, tempContexts, autoPerm, autoTemp, presets, config,
    isAgentTabSwitch,
    isAgentModeActive,
    setEditingMessageId, setConfig, setAutoPerm, setAutoTemp, saveStorage, createNewSession, 
    updateCurrentSessionTitle, currentController, setCurrentController, setSessions, 
    setCurrentSessionId, switchSession, deleteSessionById, addMessage, removeMessageByIndex, 
    replaceMessages, clearCurrentSessionMessages, setTempContexts, removeTempContextByIndex,
    setPresets,
    clearTurnApprovals,
    setIsAgentModeActive
} from './state.js';

import {
    renderChat, renderSessionList, settingsModal, historyPanel, userInput, sendBtn, 
    stopBtn, setChatState, addSystemMessage, updatePresetSelect, loadSettingsToUI, 
    renderTempAttachments, autoPermCheck, autoTempCheck, hideExecutionStatus,
    addCommandRow
} from './ui.js';

import { callLLM } from './api.js';
import { fetchPageContent, addPermanentCard, addTemporaryChip, manualAddContext } from './context.js';
import { DOM_SNAPSHOT_SCRIPT } from './domAgent.js';
import { clearPageOverlays } from './executor.js';
import { browserTools } from './tools.js';

/**
 * 注入网页的 Watchdog 脚本
 * 当检测到用户在页面上有主动交互（点击/按键）时，通知侧边栏停止自动化操作
 */
const WATCHDOG_SCRIPT = () => {
    if (window.hasAgentWatchdog) return;
    window.hasAgentWatchdog = true;
    const notify = (event) => {
        if (event && event.isTrusted === false) return; // 忽略 AI 模拟生成的事件
        window.removeEventListener('mousedown', notify, { capture: true });
        window.removeEventListener('keydown', notify, { capture: true });
        delete window.hasAgentWatchdog;
        try { chrome.runtime.sendMessage({ type: 'USER_INTERACTION_DETECTED' }); } catch(e) {}
    };
    window.addEventListener('mousedown', notify, { capture: true });
    window.addEventListener('keydown', notify, { capture: true });
};

/**
 * 强行终止 Agent 任务流并恢复 UI 状态
 */
function stopAgentTask(reason) {
    if (!isGenerating) return;
    console.log(`[Agent] 中断原因: ${reason}`);
    if (currentController) {
        currentController.abort();
        setCurrentController(null);
    }
    clearPageOverlays();
    hideExecutionStatus();
    addSystemMessage(reason);
    setIsAgentModeActive(false); 
    setChatState(false);
    saveStorage();
}

/**
 * 会话切换处理器
 */
export function handleSwitchSession(id) {
    clearPageOverlays();
    switchSession(id);
    renderChat();
    if(document.body.clientWidth < 450) historyPanel.classList.add('hidden');
    renderSessionList();
}

/**
 * 会话删除处理器
 */
export function handleDeleteSession(id, event) {
    event.stopPropagation();
    if (confirm("确定删除此对话吗？")) {
        deleteSessionById(id);
        renderChat();
        renderSessionList();
    }
}

/**
 * 消息重试处理器：回溯消息队列并重新触发 LLM 调用
 */
export function handleRetry(index) {
    if(isGenerating) return;
    const session = sessions[currentSessionId];
    const msgs = session.messages;
    const targetMsg = msgs[index];
    
    let newMessages;
    // 如果重试的是 AI 回复，则删除该回复及之后的记录；否则保留到当前用户消息
    if (targetMsg.role === 'assistant') {
        newMessages = msgs.slice(0, index);
    } else {
        newMessages = msgs.slice(0, index + 1);
    }

    // 若上一条消息是未完成的工具调用，一并移除
    const lastMsg = newMessages[newMessages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.tool_calls && lastMsg.tool_calls.length > 0) {
        newMessages.pop();
    }

    replaceMessages(newMessages);
    handleSend(true);
}

/**
 * 消息单条删除处理器
 */
export function handleDeleteMessage(index) {
    if (confirm('删除此条消息？')) {
        removeMessageByIndex(index);
        renderChat();
    }
}

/**
 * 消息编辑保存处理器
 */
export function handleEditSave(index, msg, newText) {
    msg.content = newText;
    if (msg.fullContent) msg.fullContent = newText;
    setEditingMessageId(null);
    saveStorage();
    renderChat();
}

/**
 * 临时附件移除处理器
 */
export function handleRemoveTempContext(index) {
    removeTempContextByIndex(index);
    renderTempAttachments();
}

/**
 * 核心发送逻辑：处理上下文组装、页面扫描及启动 Agent 循环
 */
export async function handleSend(isRetry = false) {
    if (isGenerating) return;
    clearTurnApprovals(); // 开启新一轮对话，清除“本轮”授权标记
    
    const text = userInput.value.trim();
    if (!isRetry && !text && tempContexts.length === 0 && !autoPerm && !autoTemp) return;

    // 根据启用的工具判断是否需要进入 Agent 模式
    const activeTools = browserTools.filter(tool => config.enabledTools?.[tool.function.name]);
    const silentTools = ['web_search', 'fetch_url_content'];
    const isAgentTurn = activeTools.some(tool => !silentTools.includes(tool.function.name));
    setIsAgentModeActive(isAgentTurn);

    if (!isRetry) {
        // 执行自动抓取逻辑
        if (autoPerm) {
            const data = await fetchPageContent();
            if (data) addPermanentCard(data);
        } 
        if (autoTemp) {
            const data = await fetchPageContent();
            if (data) addTemporaryChip(data);
        }

        // 组装带上下文的消息内容
        let fullContent = text;
        if (tempContexts.length > 0) {
            const contextXml = tempContexts.map(c => 
                `<current_page_context>
<title>${c.title}</title>
<url>${c.url}</url>
<content>${c.content}</content>
</current_page_context>`
            ).join("\n");
            fullContent = `${contextXml}\n\n${text}`;
            setTempContexts([]);
            renderTempAttachments();
        }

        addMessage({
            id: 'msg-' + Date.now(),
            role: 'user', 
            content: text, 
            fullContent: fullContent 
        });
        updateCurrentSessionTitle(text);
        userInput.value = '';
    }

    // 初始化 AI 占位消息
    addMessage({ role: 'assistant', content: '', think: '', id: "ai-" + Date.now() });
    renderChat();
    
    try {
        // 如果开启了自动化工具，在目标页面部署交互监听器
        if (isAgentTurn) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && !tab.url.startsWith('chrome')) {
                chrome.scripting.executeScript({ target: { tabId: tab.id }, func: WATCHDOG_SCRIPT });
            }
        }
        await callLLM();
    } catch(e) {
        console.error("对话流程中断:", e);
        setChatState(false);
        addSystemMessage(`发生异常: ${e.message}`);
    } finally {
        setIsAgentModeActive(false); 
        await clearPageOverlays().catch(e => console.error("覆盖层清理失败:", e));
    }
}

/**
 * 自动总结页面处理器
 */
export async function handleAutoSummarize() {
    if (isGenerating) return;
    createNewSession();
    renderChat();
    renderSessionList();

    addSystemMessage("🔍 正在提取页面核心内容...");
    const data = await fetchPageContent();
    if (!data) {
        addSystemMessage("❌ 无法访问页面内容。");
        return;
    }
    
    addTemporaryChip(data);
    userInput.value = config.summaryPrompt || "请总结此页面内容。";
    handleSend();
}

/**
 * 全局事件监听初始化
 */
export function initializeEventListeners() {
    // 视觉扫描调试按钮
    const visionBtn = document.getElementById('testVisionBtn');
    if (visionBtn) {
        visionBtn.addEventListener('click', async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) return alert("未找到目标标签页");
                if (tab.url.startsWith('chrome://')) return addSystemMessage("⚠️ 系统页面禁止注入脚本。");
                
                addSystemMessage("🕵️ 正在进行视觉元素扫描...");
                const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: DOM_SNAPSHOT_SCRIPT });
                const data = results[0]?.result;
                
                if (data && data.elements) {
                    const count = data.elements.split('\n').filter(line => line.startsWith('[ID:')).length;
                    addSystemMessage(`✅ 扫描完成，捕获 ${count} 个可交互节点。`);
                } else {
                    addSystemMessage(`❌ 扫描失败。`);
                }
            } catch (err) { addSystemMessage(`❌ 错误: ${err.message}`); }
        });
    }

    // 手动清理页面标记
    document.getElementById('clearMarkingsBtn')?.addEventListener('click', async () => {
        await clearPageOverlays();
        addSystemMessage('🧼 页面标记已清理。');
    });

    // 会话与界面控制
    document.getElementById('newChatBtn').addEventListener('click', () => {
        if(sessions[currentSessionId]?.messages.length === 0) return;
        createNewSession(); renderChat(); renderSessionList();
    });

    document.getElementById('clearContextBtn').addEventListener('click', () => {
        if(confirm('确定重置当前对话？（保留会话记录但清空当前上下文）')) {
            clearCurrentSessionMessages(); renderChat(); renderSessionList();
        }
    });

    document.getElementById('historyBtn').addEventListener('click', () => {
        renderSessionList(); historyPanel.classList.toggle('hidden');
    });
    document.getElementById('closeHistory').addEventListener('click', () => historyPanel.classList.add('hidden'));

    // 发送与停止控制
    sendBtn.addEventListener('click', () => handleSend());
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    stopBtn.addEventListener('click', () => stopAgentTask('🛑 操作已手动中止。'));

    // 设置项操作
    document.getElementById('settingsBtn').addEventListener('click', () => settingsModal.classList.remove('hidden'));
    document.getElementById('closeSettings').addEventListener('click', () => settingsModal.classList.add('hidden'));
    document.getElementById('addQuickCommandBtn').addEventListener('click', () => addCommandRow());

    // 工具管理快捷操作
    document.getElementById('enableAllToolsBtn')?.addEventListener('click', () => {
        document.querySelectorAll('#tool-toggles-container input').forEach(cb => cb.checked = true);
    });
    document.getElementById('disableAllToolsBtn')?.addEventListener('click', () => {
        document.querySelectorAll('#tool-toggles-container input').forEach(cb => cb.checked = false);
    });

    // 配置持久化保存
    document.getElementById('saveConfig').addEventListener('click', () => {
        const parseNum = (id, def) => {
            const val = parseFloat(document.getElementById(id).value);
            return isNaN(val) ? def : val;
        };

        const newConfig = {
            apiUrl: document.getElementById('apiUrl').value.trim(),
            apiKey: document.getElementById('apiKey').value.trim(),
            model: document.getElementById('modelName').value.trim(),
            systemPrompt: document.getElementById('systemPrompt').value.trim(),
            temperature: parseNum('temperature', 1.0),
            top_p: parseNum('topP', 1.0),
            customJson: document.getElementById('customJson').value.trim(),
            injectedUserContext: document.getElementById('injectedUser').value.trim(),
            injectedAssistantContext: document.getElementById('injectedAssistant').value.trim(),
            maxContextChars: parseInt(document.getElementById('maxContextChars').value, 10) || 10000,
            uiTruncateLimit: parseNum('uiTruncateLimit', 0),
            summaryPrompt: document.getElementById('summaryPrompt').value.trim(),
            quickCommands: Array.from(document.querySelectorAll('.quick-command-row')).map(row => ({
                label: row.querySelector('.row-label').value.trim(),
                value: row.querySelector('.row-value').value.trim(),
                useTemp: row.querySelector('.use-temp-check').checked
            })).filter(c => c.label),
            visionApiUrl: document.getElementById('visionApiUrl').value.trim(),
            visionApiKey: document.getElementById('visionApiKey').value.trim(),
            visionModel: document.getElementById('visionModel').value.trim(),
            toolsPrompt: document.getElementById('toolsPrompt').value.trim(),
            enabledTools: {},
        };
        document.querySelectorAll('#tool-toggles-container input').forEach(cb => {
            newConfig.enabledTools[cb.dataset.toolName] = cb.checked;
        });
        setConfig(newConfig);
        saveStorage();
        settingsModal.classList.add('hidden');
        renderChat();
        addSystemMessage('✅ 配置保存成功');
    });

    // 预设管理 (保存/删除/加载)
    document.getElementById('savePresetBtn').addEventListener('click', () => {
        const name = prompt("预设名称:");
        if(name) {
            const currentSettings = {
                name,
                apiUrl: document.getElementById('apiUrl').value,
                apiKey: document.getElementById('apiKey').value,
                model: document.getElementById('modelName').value,
                systemPrompt: document.getElementById('systemPrompt').value,
                temperature: document.getElementById('temperature').value,
                top_p: document.getElementById('topP').value,
                customJson: document.getElementById('customJson').value,
                injectedUserContext: document.getElementById('injectedUser').value,
                injectedAssistantContext: document.getElementById('injectedAssistant').value,
                maxContextChars: document.getElementById('maxContextChars').value,
                uiTruncateLimit: document.getElementById('uiTruncateLimit').value,
                summaryPrompt: document.getElementById('summaryPrompt').value,
                quickCommands: Array.from(document.querySelectorAll('.quick-command-row')).map(row => ({
                    label: row.querySelector('.row-label').value.trim(),
                    value: row.querySelector('.row-value').value.trim(),
                    useTemp: row.querySelector('.use-temp-check').checked
                })).filter(c => c.label),
                visionApiUrl: document.getElementById('visionApiUrl').value,
                visionApiKey: document.getElementById('visionApiKey').value,
                visionModel: document.getElementById('visionModel').value,
                toolsPrompt: document.getElementById('toolsPrompt').value,
                enabledTools: {}
            };
            document.querySelectorAll('#tool-toggles-container input').forEach(cb => {
                currentSettings.enabledTools[cb.dataset.toolName] = cb.checked;
            });
            const idx = presets.findIndex(p => p.name === name);
            if(idx >= 0) presets[idx] = currentSettings; else presets.push(currentSettings);
            saveStorage(); updatePresetSelect();
        }
    });

    document.getElementById('delPresetBtn')?.addEventListener('click', () => {
        const name = document.getElementById('presetSelect').value;
        if (name && confirm(`确定删除预设 "${name}" 吗？`)) {
            const idx = presets.findIndex(p => p.name === name);
            if (idx >= 0) {
                presets.splice(idx, 1);
                saveStorage();
                updatePresetSelect();
                addSystemMessage(`🗑️ 预设 "${name}" 已删除`);
            }
        }
    });

    document.getElementById('presetSelect').addEventListener('change', (e) => {
        const p = presets.find(x => x.name === e.target.value);
        if(p) {
            // 将预设值填回表单
            document.getElementById('apiUrl').value = p.apiUrl || "";
            document.getElementById('apiKey').value = p.apiKey || "";
            document.getElementById('modelName').value = p.model || "";
            document.getElementById('systemPrompt').value = p.systemPrompt || "";
            document.getElementById('temperature').value = p.temperature ?? 1.0;
            document.getElementById('topP').value = p.top_p ?? 1.0;
            document.getElementById('customJson').value = p.customJson || "";
            document.getElementById('injectedUser').value = p.injectedUserContext || "";
            document.getElementById('injectedAssistant').value = p.injectedAssistantContext || "";
            document.getElementById('maxContextChars').value = p.maxContextChars || 10000;
            document.getElementById('uiTruncateLimit').value = p.uiTruncateLimit || 0;
            document.getElementById('summaryPrompt').value = p.summaryPrompt || "";
            document.getElementById('visionApiUrl').value = p.visionApiUrl || "";
            document.getElementById('visionApiKey').value = p.visionApiKey || "";
            document.getElementById('visionModel').value = p.visionModel || "";
            document.getElementById('toolsPrompt').value = p.toolsPrompt || "";
            
            const editor = document.getElementById('quick-commands-editor');
            editor.innerHTML = '';
            if (p.quickCommands) p.quickCommands.forEach(c => addCommandRow(c.label, c.value, c.useTemp !== false));
            
            document.querySelectorAll('#tool-toggles-container input').forEach(cb => {
                cb.checked = !!p.enabledTools?.[cb.dataset.toolName];
            });
        }
    });

    // 环境变化监听
    autoPermCheck.addEventListener('change', (e) => { setAutoPerm(e.target.checked); if(autoPerm) { setAutoTemp(false); autoTempCheck.checked = false; } saveStorage(); });
    autoTempCheck.addEventListener('change', (e) => { setAutoTemp(e.target.checked); if(autoTemp) { setAutoPerm(false); autoPermCheck.checked = false; } saveStorage(); });

    document.getElementById('addPermContextBtn')?.addEventListener('click', (e) => { e.preventDefault(); manualAddContext('permanent'); });
    document.getElementById('addTempContextBtn')?.addEventListener('click', (e) => { e.preventDefault(); manualAddContext('temp'); });

    // 运行时消息处理
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'USER_INTERACTION_DETECTED') stopAgentTask('⚠️ 检测到人工干预，自动化任务已停止。');
        if (message.action === 'SUMMARIZE_PAGE') handleAutoSummarize();
    });

    // 标签页切换安全拦截
    chrome.tabs.onActivated.addListener(() => {
        if (isAgentTabSwitch) return;
        if (isGenerating && isAgentModeActive) stopAgentTask('⚠️ 标签页切换，为保证执行安全已暂停。');
    });
}
