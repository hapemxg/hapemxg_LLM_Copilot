import { tempContexts, addMessage, config } from './state.js';
import { addSystemMessage, renderChat, renderTempAttachments, chatContainer } from './ui.js';

/**
 * 核心上下文抓取逻辑：负责从当前标签页提取纯文本内容或用户选中的文本
 * 包含基础的 DOM 清理逻辑，剔除干扰性标签
 */
export async function fetchPageContent() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return null; 

    // 屏蔽浏览器内置页面
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) return null;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [config.maxContextChars || 10000], 
      func: (limit) => {
        const cleanText = (text) => text.replace(/\s+/g, ' ').trim();
        
        // 优先获取用户选中的文本
        const selection = window.getSelection().toString();
        if (selection.trim().length > 0) {
            return {
                title: document.title,
                url: document.location.href,
                content: "【用户选中的文本】\n" + cleanText(selection),
                isSelection: true
            };
        }

        // 启发式选择主要内容区域
        const article = document.querySelector('article') || document.querySelector('main') || document.querySelector('.main-content') || document.body;
        const clone = article.cloneNode(true);
        
        // 移除无关的 DOM 节点
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
    if (!results?.[0]?.result) throw new Error('提取内容为空');
    return results[0].result;

  } catch (err) {
    console.error("页面抓取失败:", err);
    if (!err.message.includes('startsWith') && !err.message.includes('undefined')) {
        addSystemMessage(`⚠️ 上下文抓取失败: ${err.message}`);
    }
    return null;
  }
}

/**
 * 手动触发上下文添加流程
 * @param {'permanent' | 'temp'} type 
 */
export async function manualAddContext(type) {
  const data = await fetchPageContent();
  if (!data) return;

  if (type === 'permanent') {
    addPermanentCard(data);
  } else {
    addTemporaryChip(data);
  }
}

/**
 * 将抓取的页面数据作为“永久记忆”卡片存入会话
 */
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

/**
 * 将抓取的页面数据存入待发送的“临时队列”
 */
export function addTemporaryChip(data) {
  tempContexts.push(data);
  renderTempAttachments();
}
