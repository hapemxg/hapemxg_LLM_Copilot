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

// DOM Elements
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

chatContainer.addEventListener('scroll', () => {
    const threshold = 8;
    const distanceFromBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
    isUserScrolling = distanceFromBottom > threshold;
});

function createActionBtn(text, onClick) {
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.innerText = text;
    btn.onclick = onClick;
    return btn;
}

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

export function renderChat() {
  chatContainer.innerHTML = '';
  const currentMsgs = sessions[currentSessionId]?.messages || [];

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

          const actionsDiv = document.createElement('div');
          actionsDiv.className = 'message-actions';
          
          const editBtn = createActionBtn('✏️', () => {
              setEditingMessageId(msg.id);
              renderChat();
          });
          actionsDiv.appendChild(editBtn);

          const delBtn = createActionBtn('🗑️', () => handleDeleteMessage(index));
          actionsDiv.appendChild(delBtn);

          if (msg.role === 'assistant' || msg.role === 'user') {
              const retryBtn = createActionBtn('🔄', () => handleRetry(index));
              actionsDiv.appendChild(retryBtn);
          }

          div.appendChild(actionsDiv);
      }
      chatContainer.appendChild(div);
    }
  });
  
  if(typeof hljs !== 'undefined') document.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
  
  if(!isGenerating) {
    setTimeout(() => {
        if (!isUserScrolling) chatContainer.scrollTop = chatContainer.scrollHeight;
    }, 0);
  }
}

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
    delBtn.title = '删除此条记录';
    delBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleDeleteMessage(index);
    };

    summary.appendChild(leftSpan);
    summary.appendChild(delBtn);
    
    const pre = document.createElement('pre');
    pre.className = 'tool-call-content';
    const content = msg.content || "";

    const limit = config.uiTruncateLimit !== undefined ? config.uiTruncateLimit : 2000;
    
    if (limit > 0 && content.length > limit) {
        pre.textContent = content.substring(0, limit) + `\n... [内容已截断，共 ${content.length} 字符。可在设置中调整阈值]`;
    } else {
        pre.textContent = content;
    }

    details.appendChild(summary);
    details.appendChild(pre);
    div.appendChild(details);
    
    // 在工具卡片下方添加操作栏
    const actionsBar = document.createElement('div');
    actionsBar.className = 'message-actions';
    actionsBar.style.opacity = '1';
    actionsBar.style.paddingLeft = '4px';
    actionsBar.style.justifyContent = 'flex-start'; 

    const continueBtn = createActionBtn('🔄 继续', (e) => {
        e.stopPropagation();
        handleRetry(index);
    });
    continueBtn.title = "网络中断或AI出错？点击基于此工具结果继续生成。";
    
    const deleteMsgBtn = createActionBtn('🗑️', (e) => {
        e.stopPropagation();
        handleDeleteMessage(index);
    });

    actionsBar.appendChild(continueBtn);
    actionsBar.appendChild(deleteMsgBtn);
    
    div.appendChild(actionsBar);
    
    chatContainer.appendChild(div);
}

export function updateAiBubble(domElement, think, content, isInit = false, autoCollapse = false, autoExpand = false) {
  let contentDiv = domElement.querySelector('.message-content');
  if (!contentDiv) return;
  
  let thinkContainer = contentDiv.querySelector('.think-container');
  
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
        if (autoCollapse && details.hasAttribute('open')) {
          details.removeAttribute('open');
        }
        if (autoExpand && !details.hasAttribute('open')) {
          details.setAttribute('open', '');
        }
      }
    }
  }

  let mdContainer = contentDiv.querySelector('.markdown-body');
  if (!mdContainer) {
    mdContainer = document.createElement('div');
    mdContainer.className = 'markdown-body';
    contentDiv.appendChild(mdContainer);
  }

  if (content) {
      let rawHtml = typeof marked !== 'undefined' ? marked.parse(content) : escapeHtml(content);
      if (typeof DOMPurify !== 'undefined') {
          rawHtml = DOMPurify.sanitize(rawHtml);
      }
      
      if (mdContainer.innerHTML !== rawHtml) {
          mdContainer.innerHTML = rawHtml;
          
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

              const langSpan = document.createElement('span');
              langSpan.className = 'code-lang';
              langSpan.innerText = lang;

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
              
              summary.appendChild(langSpan);
              summary.appendChild(btn);
              details.appendChild(summary);
              
              pre.parentNode.insertBefore(details, pre);
              details.appendChild(pre);
          });
          
          mdContainer.querySelectorAll('pre code').forEach((block) => {
             if (typeof hljs !== 'undefined') hljs.highlightElement(block);
          });
      }
  }

  if (!isInit && !isUserScrolling) {
      requestAnimationFrame(() => {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      });
  }
}

function createEditBox(msg, index) {
    const container = document.createElement('div');
    container.className = 'edit-container';
    container.style.width = "100%"; 
    
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = msg.content;
    
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
        if (newText) {
            handleEditSave(index, msg, newText);
        }
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel';
    cancelBtn.innerText = '取消';
    cancelBtn.onclick = () => {
        setEditingMessageId(null);
        renderChat();
    };

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    
    container.appendChild(textarea);
    container.appendChild(actions);
    
    return container;
}

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

export function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message system';
  div.innerHTML = `<div class="message-content">${escapeHtml(text)}</div>`;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

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
        addMessage({ 
            role: 'assistant', 
            content: '', 
            think: '', 
            id: "ai-" + Date.now() 
        });
        renderChat(); 
        handleSend();
    };
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}


// 渲染工具开关
function renderToolToggles() {
    const container = document.getElementById('tool-toggles-container');
    if (!container) return;
    container.innerHTML = ''; 

    browserTools.forEach(tool => {
        const toolName = tool.function.name;
        const label = document.createElement('label');
        label.className = 'tool-toggle-label';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `toggle-${toolName}`;
        checkbox.dataset.toolName = toolName;

        const span = document.createElement('span');
        span.textContent = toolName;
        
        label.appendChild(checkbox);
        label.appendChild(span);
        container.appendChild(label);
    });
}


export function loadSettingsToUI() {
  renderToolToggles();
  
  document.getElementById('apiUrl').value = config.apiUrl || "";
  document.getElementById('apiKey').value = config.apiKey || "";
  document.getElementById('modelName').value = config.model || "deepseek-chat";
  document.getElementById('systemPrompt').value = config.systemPrompt || "";
  document.getElementById('temperature').value = config.temperature ?? 1.0;
  document.getElementById('topP').value = config.top_p ?? 1.0;
  document.getElementById('customJson').value = config.customJson || "";
  
  document.getElementById('injectedUser').value = config.injectedUserContext || "";
  document.getElementById('injectedAssistant').value = config.injectedAssistantContext || "";
  
  document.getElementById('maxContextChars').value = config.maxContextChars || 10000;
  document.getElementById('uiTruncateLimit').value = config.uiTruncateLimit !== undefined ? config.uiTruncateLimit : 2000;

  // 视觉配置加载
  document.getElementById('visionApiUrl').value = config.visionApiUrl || "https://api.openai.com/v1/chat/completions";
  document.getElementById('visionApiKey').value = config.visionApiKey || "";
  document.getElementById('visionModel').value = config.visionModel || "gpt-4o-mini";

  document.getElementById('toolsPrompt').value = config.toolsPrompt || "";
  
  const toolToggles = document.querySelectorAll('#tool-toggles-container input[type="checkbox"]');
  toolToggles.forEach(checkbox => {
      const toolName = checkbox.dataset.toolName;
      checkbox.checked = !!config.enabledTools?.[toolName];
  });
}

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

export function showExecutionStatus(text) {
  hideExecutionStatus();
  const div = document.createElement('div');
  div.id = 'execution-status-message';
  div.className = 'message system';
  div.innerHTML = `<div class="message-content">${escapeHtml(text)}</div>`;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

export function hideExecutionStatus() {
  const existingStatus = document.getElementById('execution-status-message');
  if (existingStatus) {
    existingStatus.remove();
  }
}

export function requestUserApproval(toolName, args) {
  return new Promise((resolve) => {
    const cardId = `approval-${Date.now()}`;
    const div = document.createElement('div');
    div.id = cardId;
    div.className = 'message system';

    const argsString = JSON.stringify(args, null, 2).replace(/</g, "&lt;").replace(/>/g, "&gt;");

    div.innerHTML = `
      <div class="approval-card">
        <div class="approval-header">
          <span class="icon">🚦</span>
          <strong>需要您的授权</strong>
        </div>
        <div class="approval-body">
          <p>AI 准备执行以下操作：</p>
          <pre class="tool-call-content" style="max-height: 100px;"><strong>${toolName}</strong>\n${argsString}</pre>
        </div>
        <div class="approval-actions">
          <button class="btn-deny" data-choice="deny">❌ 拒绝</button>
          <button class="btn-approve-secondary" data-choice="session">始终 (会话)</button>
          <button class="btn-approve-secondary" data-choice="turn">始终 (本轮)</button>
          <button class="btn-approve" data-choice="once">✅ 仅本次</button>
        </div>
      </div>
    `;

    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    const cardElement = document.getElementById(cardId);
    
    cardElement.querySelector('.approval-actions').addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON') return;

        const choice = e.target.dataset.choice;
        cardElement.remove();

        switch (choice) {
            case 'once':
                resolve({ approved: true, scope: 'once' });
                break;
            case 'turn':
                resolve({ approved: true, scope: 'turn' });
                break;
            case 'session':
                resolve({ approved: true, scope: 'session' });
                break;
            case 'deny':
            default:
                resolve({ approved: false });
                break;
        }
    });
  });
}