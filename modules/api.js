// modules/api.js

import { 
    config, sessions, currentSessionId, currentController, 
    setCurrentController, addMessage, updateMessageById, saveStorage 
} from './state.js';
import { 
    renderChat, setChatState, showExecutionStatus, 
    hideExecutionStatus, updateAiBubble, addErrorWithRetry 
} from './ui.js';
import { browserTools } from './tools.js';
import { executeTool, clearPageOverlays } from './executor.js';

/**
 * 解析 LLM 返回内容中的自定义工具调用标签
 * @param {string} content - LLM返回的原始文本内容
 * @returns {{calls: Array}}
 */
function parseCustomToolCalls(content) {
    const calls = [];
    if (!content) return { calls };

    const toolCallRegex = /<\|tool_call_begin\|>([\s\S]*?)<\|tool_call_argument_begin\|>([\s\S]*?)(?:<\|tool_call_argument_end\|>)?[\s\S]*?<\|tool_call_end\|>/gi;
    const matches = [...content.matchAll(toolCallRegex)];

    for (const match of matches) {
        let rawName = match[1]; 
        let argsString = match[2].trim();

        let toolName = rawName.trim();
        toolName = toolName.replace(/^functions?\./i, '');
        toolName = toolName.replace(/:\d+$/, '');
        toolName = toolName.trim();

        // 避免空参数导致 API 报错，补全为 "{}"
        if (!argsString) argsString = "{}";

        if (toolName) {
            calls.push({
                id: `custom-tool-${Date.now()}-${calls.length}`,
                name: toolName,
                args: argsString
            });
        }
    }

    return { calls };
}


export async function callLLM() {
    if (!config.apiKey) {
        addErrorWithRetry('请配置 API Key');
        setChatState(false);
        return;
    }

    setChatState(true);
    setCurrentController(new AbortController());

    const session = sessions[currentSessionId];
    let loopCount = 0;
    const MAX_LOOPS = 15;

    try {
        while (loopCount < MAX_LOOPS) {
            loopCount++;

            if (!currentController) {
                console.warn("Agent task was aborted mid-loop.");
                break; 
            }

            // 过滤启用的工具并构建 System Prompt
            const activeTools = browserTools.filter(tool => config.enabledTools?.[tool.function.name]);
            
            let finalSystemPrompt = config.systemPrompt || "";
            if (activeTools.length > 0) {
                finalSystemPrompt = finalSystemPrompt.replace('{{TOOLS_PROMPT}}', config.toolsPrompt || "");
            } else {
                finalSystemPrompt = finalSystemPrompt.replace('{{TOOLS_PROMPT}}', "").replace(/^\s*[\r\n]/gm, '').trim();
            }

            const messagesForApi = [];
            messagesForApi.push({ role: "system", content: finalSystemPrompt });

            const permanentContexts = session.messages.filter(m => m.role === 'context');
            if (permanentContexts.length > 0) {
                const contextContent = permanentContexts.map(ctx => `
<permanent_memory_card>
  <title>${ctx.title}</title>
  <url>${ctx.url}</url>
  <content>${ctx.content}</content>
</permanent_memory_card>`).join('\n');
                messagesForApi.push({ role: "system", content: `用户标记的【永久记忆】如下，请作为长期背景参考：\n${contextContent}` });
            }

            if (config.injectedUserContext?.trim()) {
                messagesForApi.push({ role: "user", content: config.injectedUserContext.trim() });
            }
            if (config.injectedAssistantContext?.trim()) {
                messagesForApi.push({ role: "assistant", content: config.injectedAssistantContext.trim() });
            }
            
            // 定义需要被清洗掉的标签正则（发送给API时用）
            const customToolTagsRegex = /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>|<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi;

            session.messages.forEach((m) => {
                if (m.role === 'context') return;
                
                let apiMsg = { role: m.role, content: m.content || "" };
                
                // 移除 assistant 消息中的自定义工具标签
                if (m.role === 'assistant' && typeof apiMsg.content === 'string') {
                    apiMsg.content = apiMsg.content.replace(customToolTagsRegex, '').trim();
                }
                
                if (m.role === 'user' && m.fullContent && m.fullContent !== m.content) {
                    apiMsg.content = m.fullContent;
                }
                if (m.tool_calls) apiMsg.tool_calls = m.tool_calls;
                if (m.role === 'tool') {
                    apiMsg.tool_call_id = m.tool_call_id;
                    apiMsg.name = m.name || 'tool_result';
                }
                messagesForApi.push(apiMsg);
            });

            // 移除最后一条空的 Assistant 占位消息，防止 API 报错
            if (messagesForApi.length > 0) {
                const lastMsg = messagesForApi[messagesForApi.length - 1];
                if (lastMsg.role === 'assistant' && !lastMsg.content && !lastMsg.tool_calls) {
                    messagesForApi.pop(); 
                }
            }

            const currentTime = new Date().toLocaleString();
            for (let i = messagesForApi.length - 1; i >= 0; i--) {
                if (messagesForApi[i].role === 'user') {
                    messagesForApi[i].content = `[Current Time: ${currentTime}]\n${messagesForApi[i].content}`;
                    break; 
                }
            }

            const currentAiMsg = session.messages[session.messages.length - 1];
            if (currentAiMsg.role !== 'assistant') break;

            console.log(`🔄 Loop ${loopCount} Payload:`, messagesForApi);

            let requestBody = {
                model: config.model,
                messages: messagesForApi,
                stream: true,
                temperature: config.temperature || 0.3
            };

            if (activeTools.length > 0) {
                requestBody.tools = activeTools;
                requestBody.tool_choice = "auto";
            }

            if (config.customJson) {
                try {
                    const customObj = JSON.parse(config.customJson);
                    requestBody = { ...requestBody, ...customObj };
                } catch (e) { console.warn("JSON Parse Error", e); }
            }

            const response = await fetch(config.apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.apiKey}` },
                body: JSON.stringify(requestBody),
                signal: currentController?.signal
            });

            if (!response.ok) throw new Error(`API Error: ${response.status} ${await response.text()}`);

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let aiContent = "", aiThink = "", buffer = "";
            let toolCallBuffer = {};
            let isThinkingTagMode = false;
            let hasCollapsedThink = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                let lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) continue;
                    const jsonStr = trimmed.slice(6);
                    if (jsonStr === '[DONE]') break;

                    try {
                        const data = JSON.parse(jsonStr);
                        const delta = data.choices?.[0]?.delta;
                        if (!delta) continue;
                        if (delta.reasoning_content) aiThink += delta.reasoning_content;
                        if (delta.content) {
                            let contentPart = delta.content;
                            if (contentPart.includes('<think>')) {
                                isThinkingTagMode = true;
                                contentPart = contentPart.replace('<think>', '');
                            }
                            if (contentPart.includes('</think>')) {
                                isThinkingTagMode = false;
                                const parts = contentPart.split('</think>');
                                aiThink += parts[0];
                                aiContent += parts[1] || "";
                                hasCollapsedThink = true;
                            } else {
                                if (isThinkingTagMode) aiThink += contentPart;
                                else aiContent += contentPart;
                            }
                        }
                        if (delta.tool_calls) {
                            delta.tool_calls.forEach(tc => {
                                const idx = tc.index;
                                if (!toolCallBuffer[idx]) toolCallBuffer[idx] = { id: "", name: "", args: "" };
                                if (tc.id) toolCallBuffer[idx].id = tc.id;
                                if (tc.function?.name) toolCallBuffer[idx].name += tc.function.name;
                                if (tc.function?.arguments) toolCallBuffer[idx].args += tc.function.arguments;
                            });
                        }
                        // 实时更新 UI，让用户看到打字机效果
                        updateMessageById(currentAiMsg.id, { think: aiThink, content: aiContent });
                        const aiMsgEl = document.querySelector(`.message[data-id="${currentAiMsg.id}"]`);
                        if (aiMsgEl) {
                            const shouldCollapse = (aiContent.length > 0 && aiThink.length > 0 && !hasCollapsedThink) || hasCollapsedThink;
                            const shouldExpand = aiThink.length > 0 && aiContent.length === 0;
                            updateAiBubble(aiMsgEl, aiThink, aiContent, false, shouldCollapse, shouldExpand);
                        }
                    } catch (e) {}
                }
            }

            let nativeToolCalls = Object.values(toolCallBuffer);
            let extractedCustomToolCalls = []; // 用于存储从文本中提取的工具
            let needsArtificialToolResult = false; // 标记是否需要伪造工具结果

            // 1. 尝试从 content 解析
            if (nativeToolCalls.length === 0 && aiContent.includes('<|tool_call_begin|>')) {
                const parsedResult = parseCustomToolCalls(aiContent);
                if (parsedResult.calls.length > 0) {
                    console.log("Extracted tool calls from Content:", parsedResult.calls);
                    extractedCustomToolCalls = parsedResult.calls;
                    needsArtificialToolResult = true; 
                    // 这里不要修改 aiContent，保留原始文本给 UI
                }
            }
            
            // 2. 尝试从 thinking 解析
            if (nativeToolCalls.length === 0 && aiThink.includes('<|tool_call_begin|>')) {
                const parsedThink = parseCustomToolCalls(aiThink);
                if (parsedThink.calls.length > 0) {
                    console.log("Extracted tool calls from Thinking:", parsedThink.calls);
                    extractedCustomToolCalls.push(...parsedThink.calls);
                    needsArtificialToolResult = true; 
                     // 这里不要修改 aiThink，保留原始文本给 UI
                }
            }


            const allToolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : extractedCustomToolCalls;
            
            // 更新 UI 和 state：此时 aiContent 和 aiThink 包含了完整的原始标签
            updateMessageById(currentAiMsg.id, {
                think: aiThink,
                content: aiContent,
                tool_calls: allToolCalls.length > 0 ? allToolCalls.map(tc => ({
                    id: tc.id, 
                    type: "function", 
                    function: { 
                        name: tc.name, 
                        // 确保 arguments 永远不是空字符串
                        arguments: tc.args || "{}" 
                    }
                })) : null
            });
            
            renderChat();

            if (allToolCalls.length === 0) {
                break;
            }

            if (needsArtificialToolResult && extractedCustomToolCalls.length > 0) {
                 console.log("Simulating tool execution success for custom tool calls.");
                 for (const tc of extractedCustomToolCalls) {
                     let simulatedResult = "";
                     switch (tc.name) {
                         case "open_url":
                             try {
                                 const parsedArgs = JSON.parse(tc.args);
                                 simulatedResult = `已成功打开网址: ${parsedArgs.url}. [模拟] 页面内容已加载。`;
                             } catch {
                                 simulatedResult = `已尝试打开网址: (参数解析失败). [模拟] 页面内容已加载。`;
                             }
                             break;
                         case "get_page_interactables":
                             simulatedResult = `[模拟] 页面交互元素已获取。请继续根据此信息进行操作。`;
                             break;
                         case "read_page_content":
                             simulatedResult = `[模拟] 页面内容已读取。`;
                             break;
                         case "click_element":
                             simulatedResult = `[模拟] 已尝试点击元素 ID: ${tc.args}. 页面已更新。`;
                             break;
                         case "type_text":
                             simulatedResult = `[模拟] 已尝试在元素 ID: ${tc.args.element_id} 输入文本。`;
                             break;
                         default:
                             simulatedResult = `[模拟] 工具 ${tc.name} 已成功执行。`;
                     }

                     addMessage({
                         id: 'tool-' + Date.now(),
                         role: 'tool',
                         tool_call_id: tc.id,
                         name: tc.name,
                         content: simulatedResult
                     });
                 }
            } else {
                showExecutionStatus("⚡ 执行工具中...");
                for (const tc of allToolCalls) {
                    const result = await safeExecute(tc.name, tc.args);
                    addMessage({
                        id: 'tool-' + Date.now(),
                        role: 'tool',
                        tool_call_id: tc.id,
                        name: tc.name,
                        content: typeof result === 'string' ? result : JSON.stringify(result)
                    });
                }
                hideExecutionStatus();
            }

            addMessage({
                role: 'assistant',
                content: '',
                think: '',
                id: "ai-" + Date.now()
            });
            renderChat();
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error("Agent Error:", err);
            setChatState(false); 
            renderChat();
            addErrorWithRetry(err.message);
        }
    } finally {
        setChatState(false);
        saveStorage();
        await clearPageOverlays().catch(e => console.error("Overlay cleanup failed:", e));
    }
}

async function safeExecute(name, argsStr) {
    try {
        let cleanArgs = argsStr.replace(/```json/g, '').replace(/```/g, '').trim();
        cleanArgs = cleanArgs.replace(/[\r\n\t]/g, ' ');
        
        const args = JSON.parse(cleanArgs || "{}");
        return await executeTool(name, args);
    } catch (e) {
        console.error("Tool execution failed:", e);
        return `Error parsing arguments for ${name}: ${e.message}. Args content: ${argsStr}`;
    }
}