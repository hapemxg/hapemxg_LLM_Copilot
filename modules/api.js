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
 */
function parseCustomToolCalls(content) {
    const calls = [];
    if (!content) return { calls };

    const toolCallRegex = /<\|tool_call_begin\|>([\s\S]*?)<\|tool_call_argument_begin\|>([\s\S]*?)(?:<\|tool_call_argument_end\|>|(?=<\|tool_call_end\|>))[\s\S]*?<\|tool_call_end\|>/gi;
    const matches = [...content.matchAll(toolCallRegex)];

    for (const match of matches) {
        let rawName = match[1]; 
        let argsString = match[2].trim();

        let toolName = rawName.trim();
        toolName = toolName.replace(/^functions?\./i, '');
        toolName = toolName.replace(/:\d+$/, '');
        toolName = toolName.trim();

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

            // 过滤启用的工具
            const activeTools = browserTools.filter(tool => config.enabledTools?.[tool.function.name]);
            
            const silentTools = ['web_search', 'fetch_url_content'];
            const promptInjectingTools = activeTools.filter(tool => !silentTools.includes(tool.function.name));

            let finalSystemPrompt = config.systemPrompt || "";
            if (promptInjectingTools.length > 0) {
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
            
            const customToolTagsRegex = /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>|<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi;

            session.messages.forEach((m) => {
                if (m.role === 'context') return;
                
                let apiMsg = { role: m.role, content: m.content || "" };
                
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

            // 移除最后一条空的 Assistant 消息
            if (messagesForApi.length > 0) {
                const lastMsg = messagesForApi[messagesForApi.length - 1];
                if (lastMsg.role === 'assistant' && !lastMsg.content && !lastMsg.tool_calls) {
                    messagesForApi.pop(); 
                }
            }

            const currentTime = new Date().toLocaleString();
            for (let i = messagesForApi.length - 1; i >= 0; i--) {
                if (messagesForApi[i].role === 'user') {
                    messagesForApi[i].content = `[当前时间: ${currentTime}]，对话请以该时间为基准。\n${messagesForApi[i].content}`;
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
            let extractedCustomToolCalls = []; 
            let needsArtificialToolResult = false; 

            if (nativeToolCalls.length === 0 && aiContent.includes('<|tool_call_begin|>')) {
                const parsedResult = parseCustomToolCalls(aiContent);
                if (parsedResult.calls.length > 0) {
                    extractedCustomToolCalls = parsedResult.calls;
                    needsArtificialToolResult = true; 
                }
            }
            
            if (nativeToolCalls.length === 0 && aiThink.includes('<|tool_call_begin|>')) {
                const parsedThink = parseCustomToolCalls(aiThink);
                if (parsedThink.calls.length > 0) {
                    extractedCustomToolCalls.push(...parsedThink.calls);
                    needsArtificialToolResult = true; 
                }
            }

            const cleanContent = aiContent.trim();
            const cleanThink = aiThink.trim();

            const allToolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : extractedCustomToolCalls;
            
            updateMessageById(currentAiMsg.id, {
                think: cleanThink,
                content: cleanContent,
                tool_calls: allToolCalls.length > 0 ? allToolCalls.map(tc => ({
                    id: tc.id, 
                    type: "function", 
                    function: { 
                        name: tc.name, 
                        arguments: tc.args || "{}" 
                    }
                })) : null
            });
            
            renderChat();

            if (allToolCalls.length === 0) {
                break;
            }

            if (needsArtificialToolResult && extractedCustomToolCalls.length > 0) {
                 showExecutionStatus("⚡ 执行工具中...");
                 
                 for (const tc of extractedCustomToolCalls) {
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