import { tempContexts, addMessage, config } from './state.js';
import { addSystemMessage, renderChat, renderTempAttachments, chatContainer } from './ui.js';

export async function fetchPageContent() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('无法获取当前标签页');
    
    if (!tab.url) return null; 

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) return null;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [config.maxContextChars || 10000], 
      func: (limit) => {
        const cleanText = (text) => text.replace(/\s+/g, ' ').trim();
        
        const selection = window.getSelection().toString();
        if (selection.trim().length > 0) {
            return {
                title: document.title,
                url: document.location.href,
                content: "【用户选中的文本】\n" + cleanText(selection),
                isSelection: true
            };
        }

        const article = document.querySelector('article') || document.querySelector('main') || document.querySelector('.main-content') || document.body;
        const clone = article.cloneNode(true);
        const trash = clone.querySelectorAll('script, style, noscript, iframe, nav, footer, .ad, .ads, .comment, .sidebar');
        trash.forEach(el => el.remove());

        return {
          title: document.title,
          url: document.location.href,
          content: cleanText(clone.innerText).substring(0, limit)
        };
      }
    });

    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
    if (!results?.[0]?.result) throw new Error('无法读取网页内容');
    return results[0].result;

  } catch (err) {
    console.error(err);
    if (!err.message.includes('startsWith') && !err.message.includes('undefined')) {
        addSystemMessage(`⚠️ 读取失败: ${err.message}`);
    }
    return null;
  }
}

export async function manualAddContext(type) {
  const data = await fetchPageContent();
  if (!data) return;

  if (type === 'permanent') {
    addPermanentCard(data);
  } else {
    addTemporaryChip(data);
  }
}

export function addPermanentCard(data) {
  const contextMsg = {
    id: 'ctx-' + Date.now(),
    role: 'context', 
    title: data.title,
    url: data.url,
    content: data.content,
    meta: `${Math.floor(data.content.length / 1000)}k chars`
  };
  addMessage(contextMsg);
  renderChat();
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

export function addTemporaryChip(data) {
  tempContexts.push(data);
  renderTempAttachments();
}