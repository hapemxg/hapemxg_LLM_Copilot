import {
    sessions, currentSessionId, editingMessageId, isGenerating, tempContexts, presets, config,
    setEditingMessageId, saveStorage, setIsGenerating,
    addMessage
} from './state.js';

import {
    handleRetry, handleDeleteMessage, handleEditSave, handleSwitchSession,
    handleDeleteSession, handleRemoveTempContext,
    handleSend
} from './events.js';

import { escapeHtml } from './utils.js';
import { browserTools } from './tools.js';

/**
 * UI 组件集与核心 DOM 节点引用
 */
export const chatContainer = document.getElementById('chat-container');
export const userInput = document.getElementById('userInput');
export const sendBtn = document.getElementById('sendBtn');
export const stopBtn = document.getElementById('stopBtn');
export const historyPanel = document.getElementById('history-panel');
export const attachmentsArea = document.getElementById('attachments-area');
export const settingsModal = document.getElementById('settings-modal');
export const autoPermCheck = document.getElementById('autoPermCheck');
export const autoTempCheck = document.getElementById('autoTempCheck');

let isUserScrolling = false;

// 监听用户滚动行为，用于控制自动滚动到底部
chatContainer.addEventListener('scroll', () => {
    const threshold = 8;
    const distanceFromBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
    isUserScrolling = distanceFromBottom > threshold;
});

/**
 * 辅助函数：创建操作按钮
 */
function createActionBtn(text, onClick) {
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.innerText = text;
    btn.onclick = onClick;
    return btn;
}

/**
 * 渲染侧边栏历史会话列表
 */
export function renderSessionList() {
  const list = document.getElementById('session-list');
  if(!list) return;
  list.innerHTML = '';
  const sortedKeys = Object.keys(sessions).sort((a, b) => sessions[b].timestamp - sessions[a].timestamp);
  sortedKeys.forEach(id => {
    const s = sessions[id];
    const item = document.createElement('div');
    item.className = `session-item ${id === currentSessionId ? 'active' : ''}`;
    item.onclick = () => handleSwitchSession(id);
    const dateStr = new Date(parseInt(id)).toLocaleDateString();
    item.innerHTML = `
      <div style="overflow:hidden; flex:1;">
        <div style="font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(s.title)}</div>
        <span class="session-time">${dateStr} · ${s.messages.length}条</span>
      </div>
      <span class="del-session" title="删除">×</span>
    `;
    item.querySelector('.del-session').onclick = (e) => handleDeleteSession(id, e);
    list.appendChild(item);
  });
}

/**
 * 渲染待发送的临时上下文附件标记
 */
export function renderTempAttachments() {
  attachmentsArea.innerHTML = '';
  tempContexts.forEach((item, index) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.innerHTML = `<span>👁️</span><span style="max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.title)}</span><span class="chip-remove" style="cursor:pointer; margin-left:4px;">×</span>`;
    chip.querySelector('.chip-remove').onclick = () => handleRemoveTempContext(index);
    attachmentsArea.appendChild(chip);
  });
}

/**
 * 更新输入框及发送/停止按钮的交互状态
 */
export function setChatState(generating) {
  setIsGenerating(generating);
  if (generating) {
    userInput.disabled = true;
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
  } else {
    userInput.disabled = false;
    userInput.focus();
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
  }
}

/**
 * 主对话区域全量渲染
 */
export function renderChat() {
  chatContainer.innerHTML = '';
  const currentMsgs = sessions[currentSessionId]?.messages || [];

  // 初始状态：显示欢迎卡片及快捷指令
  if (currentMsgs.length === 0 && !isGenerating) {
    const quickCmdsContainer = document.createElement('div');
    quickCmdsContainer.id = 'quick-commands-container';
    quickCmdsContainer.className = 'quick-commands-container';
    renderQuickCommands(quickCmdsContainer);
    chatContainer.appendChild(quickCmdsContainer);
  }

  currentMsgs.forEach((msg, index) => {
    if (msg.role === 'context') {
      renderFileCard(msg, index);
    } else if (msg.role === 'tool') {
      renderToolCallResult(msg, index);
    } else { 
      const div = document.createElement('div');
      div.className = `message ${msg.role}`;
      if (msg.id) div.setAttribute('data-id', msg.id);

      if (editingMessageId === msg.id) {
          div.appendChild(createEditBox(msg, index));
      } else {
          const bubble = document.createElement('div');
          bubble.className = 'message-bubble';
          
          const contentDiv = document.createElement('div');
          contentDiv.className = 'message-content';
          
          bubble.appendChild(contentDiv); 
          div.appendChild(bubble); 

          if (msg.role === 'assistant') {
            updateAiBubble(div, msg.think, msg.content, true);
          } else {
            contentDiv.textContent = msg.content;
            contentDiv.style.whiteSpace = "pre-wrap"; 
          }

          // 消息操作工具条
          const actionsDiv = document.createElement('div');
          actionsDiv.className = 'message-actions';
          actionsDiv.appendChild(createActionBtn('✏️', () => {
              setEditingMessageId(msg.id);
              renderChat();
          }));
          actionsDiv.appendChild(createActionBtn('🗑️', () => handleDeleteMessage(index)));
          if (msg.role === 'assistant' || msg.role === 'user') {
              actionsDiv.appendChild(createActionBtn('🔄', () => handleRetry(index)));
          }
          div.appendChild(actionsDiv);
      }
      chatContainer.appendChild(div);
    }
  });
  
  // 代码高亮异步处理
  if(typeof hljs !== 'undefined') document.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
  
  // 渲染完成后的自动滚动处理
  if(!isGenerating) {
    setTimeout(() => {
        if (!isUserScrolling) chatContainer.scrollTop = chatContainer.scrollHeight;
    }, 0);
  }
}

/**
 * 渲染工具执行结果卡片
 */
function renderToolCallResult(msg, index) {
    const div = document.createElement('div');
    div.className = 'message tool';
    div.setAttribute('data-id', msg.id);

    const details = document.createElement('details');
    details.className = 'tool-call-container';
    
    const summary = document.createElement('summary');
    summary.className = 'tool-call-summary';

    const leftSpan = document.createElement('span');
    leftSpan.style.display = 'flex';
    leftSpan.style.alignItems = 'center';
    leftSpan.style.gap = '8px';
    leftSpan.innerHTML = `
        <span class="tool-icon">🛠️</span>
        <span class="tool-name">工具调用: ${escapeHtml(msg.name || 'unknown_tool')}</span>
        <span class="tool-status">执行成功</span>
    `;
    
    const delBtn = document.createElement('button');
    delBtn.className = 'tool-del-btn';
    delBtn.innerHTML = '×';
    delBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); handleDeleteMessage(index); };

    summary.appendChild(leftSpan);
    summary.appendChild(delBtn);
    
    const pre = document.createElement('pre');
    pre.className = 'tool-call-content';
    const content = msg.content || "";

    // 针对超长结果进行 UI 侧截断，优化大模型上下文注入
    const limit = config.uiTruncateLimit !== undefined ? config.uiTruncateLimit : 2000;
    if (limit > 0 && content.length > limit) {
        pre.textContent = content.substring(0, limit) + `\n... [内容已截断，共 ${content.length} 字符]`;
    } else {
        pre.textContent = content;
    }

    details.appendChild(summary);
    details.appendChild(pre);
    div.appendChild(details);
    
    // 工具卡片底部的快捷重试工具条
    const actionsBar = document.createElement('div');
    actionsBar.className = 'message-actions';
    actionsBar.style.opacity = '1';
    actionsBar.style.justifyContent = 'flex-start'; 

    actionsBar.appendChild(createActionBtn('🔄 继续', () => handleRetry(index)));
    actionsBar.appendChild(createActionBtn('🗑️', () => handleDeleteMessage(index)));
    div.appendChild(actionsBar);
    
    chatContainer.appendChild(div);
}

/**
 * AI 气泡更新逻辑：支持思考链折叠展示与 Markdown 内容动态解析
 */
export function updateAiBubble(domElement, think, content, isInit = false, autoCollapse = false, autoExpand = false) {
  let contentDiv = domElement.querySelector('.message-content');
  if (!contentDiv) return;
  
  let thinkContainer = contentDiv.querySelector('.think-container');
  
  // 处理思考链内容
  if (think) {
    if (!thinkContainer) {
      const shouldOpen = autoExpand || (isInit && !content);
      const openState = shouldOpen ? 'open' : '';
      const html = `<div class="think-container"><details ${openState}><summary>深度思考</summary><pre>${escapeHtml(think)}</pre></details></div>`;
      contentDiv.insertAdjacentHTML('afterbegin', html);
    } else {
      const pre = thinkContainer.querySelector('pre');
      if (pre) pre.textContent = think;
      const details = thinkContainer.querySelector('details');
      if (details) {
        if (autoCollapse && details.hasAttribute('open')) details.removeAttribute('open');
        if (autoExpand && !details.hasAttribute('open')) details.setAttribute('open', '');
      }
    }
  }

  let mdContainer = contentDiv.querySelector('.markdown-body');
  if (!mdContainer) {
    mdContainer = document.createElement('div');
    mdContainer.className = 'markdown-body';
    contentDiv.appendChild(mdContainer);
  }

  // 增量式 Markdown 渲染与安全过滤
  if (content) {
      let rawHtml = typeof marked !== 'undefined' ? marked.parse(content) : escapeHtml(content);
      if (typeof DOMPurify !== 'undefined') rawHtml = DOMPurify.sanitize(rawHtml);
      
      if (mdContainer.innerHTML !== rawHtml) {
          mdContainer.innerHTML = rawHtml;
          
          // 为 Markdown 中的代码块注入 Copy 按钮及容器
          mdContainer.querySelectorAll('pre').forEach((pre) => {
              if (pre.parentElement.tagName === 'DETAILS') return;
              const codeEl = pre.querySelector('code');
              const codeText = codeEl?.innerText || pre.innerText;
              const langMatch = codeEl ? codeEl.className.match(/language-(\S+)/) : null;
              const lang = langMatch ? langMatch[1] : 'code';

              const details = document.createElement('details');
              details.className = 'code-block-container';
              details.open = true;

              const summary = document.createElement('summary');
              summary.className = 'code-header';
              summary.innerHTML = `<span class="code-lang">${lang}</span>`;

              const btn = document.createElement('button');
              btn.className = 'copy-code-btn';
              btn.innerText = 'Copy';
              btn.onclick = (e) => {
                  e.stopPropagation(); 
                  navigator.clipboard.writeText(codeText).then(() => {
                      btn.innerText = 'Copied!';
                      setTimeout(() => btn.innerText = 'Copy', 2000);
                  });
              };
              
              summary.appendChild(btn);
              details.appendChild(summary);
              pre.parentNode.insertBefore(details, pre);
              details.appendChild(pre);
          });
          
          // 实时高亮新生成代码块
          mdContainer.querySelectorAll('pre code').forEach((block) => {
             if (typeof hljs !== 'undefined') hljs.highlightElement(block);
          });
      }
  }

  // 非初始化状态下，随内容生成自动滚动到底部
  if (!isInit && !isUserScrolling) {
      requestAnimationFrame(() => {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      });
  }
}

/**
 * 消息编辑框构建逻辑
 */
function createEditBox(msg, index) {
    const container = document.createElement('div');
    container.className = 'edit-container';
    
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = msg.content;
    
    // 自动调整高度并聚焦
    setTimeout(() => {
        textarea.style.height = 'auto';
        textarea.style.height = (textarea.scrollHeight + 10) + 'px';
        textarea.focus();
    }, 0);
    
    const actions = document.createElement('div');
    actions.className = 'edit-actions';
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-save';
    saveBtn.innerText = '保存';
    saveBtn.onclick = () => {
        const newText = textarea.value.trim();
        if (newText) handleEditSave(index, msg, newText);
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel';
    cancelBtn.innerText = '取消';
    cancelBtn.onclick = () => { setEditingMessageId(null); renderChat(); };

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    container.appendChild(textarea);
    container.appendChild(actions);
    return container;
}

/**
 * 渲染上下文/永久记忆文件卡片
 */
function renderFileCard(msg, index) {
    const div = document.createElement('div');
    div.className = 'message context';
    div.innerHTML = `
      <div class="file-card">
        <div class="file-icon">📄</div>
        <div class="file-info">
          <div class="file-title" title="${escapeHtml(msg.title)}">${escapeHtml(msg.title)}</div>
          <div class="file-meta">永久记忆 · ${msg.meta || 'Web Page'}</div>
        </div>
        <div class="file-actions">
          <button class="action-btn delete-file" title="删除此记忆">🗑️</button>
        </div>
      </div>
    `;
    div.querySelector('.delete-file').onclick = () => handleDeleteMessage(index);
    chatContainer.appendChild(div);
}

/**
 * 向 UI 插入系统级提示消息
 */
export function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message system';
  div.innerHTML = `<div class="message-content">${escapeHtml(text)}</div>`;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

/**
 * 显示带重试逻辑的错误提示
 */
export function addErrorWithRetry(text) {
    const div = document.createElement('div');
    div.className = 'message system error'; 
    div.innerHTML = `
      <div style="background:#fff0f0; border:1px solid #ffcccc; padding:10px; border-radius:8px; display:inline-block; text-align:left;">
        <div style="color:#d32f2f; margin-bottom:6px;">❌ ${escapeHtml(text)}</div>
        <button class="retry-btn-dynamic" style="background:#fff; border:1px solid #d32f2f; color:#d32f2f; padding:4px 10px; cursor:pointer; border-radius:4px; font-size:12px;">🔄 点击重试</button>
      </div>
    `;
    div.querySelector('button').onclick = () => { 
        div.remove();
        addMessage({ role: 'assistant', content: '', think: '', id: "ai-" + Date.now() });
        renderChat(); 
        handleSend();
    };
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

/**
 * 渲染设置界面中的工具功能开关
 */
function renderToolToggles() {
    const container = document.getElementById('tool-toggles-container');
    if (!container) return; 
    container.innerHTML = ''; 

    browserTools.forEach(tool => {
        const toolName = tool.function.name;
        const label = document.createElement('label');
        label.className = 'tool-toggle-label';
        label.innerHTML = `<input type="checkbox" id="toggle-${toolName}" data-tool-name="${toolName}"><span>${toolName}</span>`;
        container.appendChild(label);
    });
}

import { fetchPageContent, addTemporaryChip } from './context.js';

/**
 * 首页快捷指令面板渲染
 */
function renderQuickCommands(container) {
    if (!config.quickCommands || config.quickCommands.length === 0) return;
    config.quickCommands.forEach(cmd => {
        const btn = document.createElement('button');
        btn.className = 'quick-command-btn';
        btn.innerHTML = `<span>${escapeHtml(cmd.label)}</span>`;
        btn.onclick = async () => {
            if (cmd.useTemp) {
                const data = await fetchPageContent();
                if (data) addTemporaryChip(data);
            }
            userInput.value = cmd.value;
            handleSend();
        };
        container.appendChild(btn);
    });
}

/**
 * 动态向快捷指令编辑器添加一行
 */
export function addCommandRow(label = "", value = "", useTemp = true) {
    const container = document.getElementById('quick-commands-editor');
    if (!container || container.querySelectorAll('.quick-command-row').length >= 10) return;

    const row = document.createElement('div');
    row.className = 'quick-command-row';
    row.innerHTML = `
        <div class="quick-command-line">
            <input type="text" class="row-label" placeholder="标签" value="${escapeHtml(label)}">
            <div class="row-actions">
                <label class="row-temp-check" title="抓取网页"><input type="checkbox" class="use-temp-check" ${useTemp ? 'checked' : ''}><span>👁️</span></label>
                <button class="del-row-btn">🗑️</button>
            </div>
        </div>
        <div class="quick-command-line">
            <input type="text" class="row-value" placeholder="指令" value="${escapeHtml(value)}">
        </div>
    `;
    row.querySelector('.del-row-btn').onclick = () => row.remove();
    container.appendChild(row);
}

/**
 * 将持久化配置同步到设置 Modal
 */
export function loadSettingsToUI() {
  renderToolToggles();
  document.getElementById('apiUrl').value = config.apiUrl || "";
  document.getElementById('apiKey').value = config.apiKey || "";
  document.getElementById('modelName').value = config.model || "deepseek-chat";
  document.getElementById('systemPrompt').value = config.systemPrompt || "";
  document.getElementById('temperature').value = config.temperature ?? 1.0;
  document.getElementById('topP').value = config.top_p ?? 1.0;
  document.getElementById('customJson').value = config.customJson || "";
  document.getElementById('summaryPrompt').value = config.summaryPrompt || "";
  
  const editorContainer = document.getElementById('quick-commands-editor');
  if (editorContainer) {
      editorContainer.innerHTML = '';
      if (config.quickCommands) config.quickCommands.forEach(c => addCommandRow(c.label, c.value, c.useTemp !== false));
  }
  
  document.getElementById('injectedUser').value = config.injectedUserContext || "";
  document.getElementById('injectedAssistant').value = config.injectedAssistantContext || "";
  document.getElementById('maxContextChars').value = config.maxContextChars || 10000;
  document.getElementById('uiTruncateLimit').value = config.uiTruncateLimit !== undefined ? config.uiTruncateLimit : 2000;
  document.getElementById('visionApiUrl').value = config.visionApiUrl || "";
  document.getElementById('visionApiKey').value = config.visionApiKey || "";
  document.getElementById('visionModel').value = config.visionModel || "";
  document.getElementById('toolsPrompt').value = config.toolsPrompt || "";
  
  document.querySelectorAll('#tool-toggles-container input').forEach(cb => cb.checked = !!config.enabledTools?.[cb.dataset.toolName]);
}

/**
 * 更新设置中的配置预设下拉列表
 */
export function updatePresetSelect() {
  const select = document.getElementById('presetSelect');
  select.innerHTML = '<option value="">-- 选择预设 --</option>';
  presets.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    select.appendChild(opt);
  });
}

/**
 * 在 UI 中显示 Agent 执行状态消息
 */
export function showExecutionStatus(text) {
  hideExecutionStatus();
  const div = document.createElement('div');
  div.id = 'execution-status-message';
  div.className = 'message system';
  div.innerHTML = `<div class="message-content">${escapeHtml(text)}</div>`;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

/**
 * 移除 Agent 执行状态消息
 */
export function hideExecutionStatus() {
  const el = document.getElementById('execution-status-message');
  if (el) el.remove();
}

/**
 * 弹出工具执行授权请求卡片
 */
export function requestUserApproval(toolName, args) {
  return new Promise((resolve) => {
    const cardId = `approval-${Date.now()}`;
    const div = document.createElement('div');
    div.id = cardId;
    div.className = 'message system';
    const argsString = JSON.stringify(args, null, 2).replace(/</g, "&lt;");

    div.innerHTML = `
      <div class="approval-card">
        <div class="approval-header"><strong>🚦 授权请求</strong></div>
        <div class="approval-body">
          <p>AI 请求执行：<strong>${toolName}</strong></p>
          <pre class="tool-call-content">${argsString}</pre>
        </div>
        <div class="approval-actions">
          <button class="btn-deny" data-choice="deny">拒绝</button>
          <button class="btn-approve-secondary" data-choice="session">会话始终允许</button>
          <button class="btn-approve-secondary" data-choice="turn">本轮允许</button>
          <button class="btn-approve" data-choice="once">允许本次</button>
        </div>
      </div>
    `;

    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    div.querySelector('.approval-actions').addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON') return;
        const choice = e.target.dataset.choice;
        div.remove();
        resolve({ approved: choice !== 'deny', scope: choice });
    });
  });
}
