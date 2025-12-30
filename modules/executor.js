import { DOM_SNAPSHOT_SCRIPT, CLEAR_OVERLAY_SCRIPT } from './domAgent.js';
import { requestUserApproval } from './ui.js';
import { getApprovalSetting, setGlobalApprovalSetting, config, setIsAgentTabSwitch } from './state.js';

/**
 * 等待目标页面加载就绪
 * @param {number} tabId 
 */
async function waitForPageLoad(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => new Promise(resolve => {
                if (document.readyState === 'complete') return resolve();
                const timeout = setTimeout(resolve, 8000); 
                window.addEventListener('load', () => {
                    clearTimeout(timeout);
                    resolve();
                }, { once: true });
            })
        });
        // 额外延迟以确保动态内容渲染
        return new Promise(resolve => setTimeout(resolve, 1000)); 
    } catch(e) { 
        console.warn("页面加载等待超时或失败:", e.message);
        return; 
    }
}

/**
 * 获取活跃标签页的文本摘要
 * @param {number} tabId 
 */
async function readActiveTabContent(tabId) {
    try {
        const readRes = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            args: [config.maxContextChars || 15000],
            func: (limit) => {
                const article = document.querySelector('article') || document.querySelector('main') || document.body;
                const text = article.innerText.substring(0, limit);
                return `标题是 "${document.title}". 页面内容摘要如下:\n${text}`;
            }
        });
        return readRes?.[0]?.result || "无法读取页面内容。";
    } catch (e) {
        console.error("读取页面内容失败:", e);
        return `错误: ${e.message}`;
    }
}

/**
 * 调用视觉模型识别截图中的 ID
 * @param {string} base64Image 图片数据
 * @param {string} targetDescription 用户描述的目标元素
 */
async function callVisionAPI(base64Image, targetDescription) {
    if (!config.visionApiKey) {
        return "错误：未配置视觉模型 API Key。";
    }

    try {
        const response = await fetch(config.visionApiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${config.visionApiKey}`
            },
            body: JSON.stringify({
                model: config.visionModel,
                messages: [
                    {
                        role: "system",
                        content: `你是一个极其精准的网页视觉分析助手，专门负责从带有红色ID标记的截图中提取元素ID。\n\n# 关键规则\n- 只返回ID数字。\n- 忽略内容中的数字，只看红色方块里的白字ID。`
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: `寻找元素：${targetDescription}。对应的红色数字ID是多少？` },
                            {
                                type: "image_url",
                                image_url: { url: base64Image, detail: "high" }
                            }
                        ]
                    }
                ],
                max_tokens: 300
            })
        });

        if (!response.ok) throw new Error(`API HTTP ${response.status}`);
        const data = await response.json();
        return `视觉模型分析结果：${data.choices?.[0]?.message?.content || "无返回内容"}`;
    } catch (e) {
        console.error("Vision API Error:", e);
        return `调用视觉模型失败: ${e.message}`;
    }
}

/**
 * 核心动作执行机：负责工具的分发、授权校验与结果反馈
 */
export async function executeTool(name, args) {
  try {
    // 敏感工具授权校验
    const DANGEROUS_TOOLS = ['click_element', 'open_url', 'type_text'];
    if (DANGEROUS_TOOLS.includes(name)) {
      const existingApproval = getApprovalSetting(name);
      if (!existingApproval) { 
        const userChoice = await requestUserApproval(name, args);
        if (!userChoice.approved) {
          return `[系统提示] 用户已手动拒绝执行工具 ${name}。`;
        }
        if (userChoice.scope === 'session' || userChoice.scope === 'turn') {
          setGlobalApprovalSetting(userChoice.scope);
        }
      }
    }

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return "错误: 未找到活跃标签页";

    switch (name) {
      case "open_url":
        setIsAgentTabSwitch(true);
        try {
            const newTab = await chrome.tabs.create({ url: args.url, active: true });
            await waitForPageLoad(newTab.id);
            const newPageContent = await readActiveTabContent(newTab.id);
            return `已打开网址: ${args.url}. 新页面摘要: ${newPageContent}`;
        } finally { 
            setIsAgentTabSwitch(false); 
        }

      case "get_page_interactables":
        await waitForPageLoad(activeTab.id);
        const snapshotRes = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: DOM_SNAPSHOT_SCRIPT
        });
        if (!snapshotRes?.[0]?.result) return "错误: 无法获取交互元素快照。";
        return snapshotRes[0].result.elements;

      case "read_page_content":
        await waitForPageLoad(activeTab.id);
        return await readActiveTabContent(activeTab.id);
      
      case "click_element": {
        setIsAgentTabSwitch(true);
        let clickResult = "点击指令已发送";
        try {
          const [preClickTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const oldUrl = preClickTab.url;

          const clickRes = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            args: [args.element_id],
            func: (id) => {
                const el = document.querySelector(`[data-agent-id="${id}"]`);
                if (!el) return `错误: 未找到 ID=${id} 的元素`;
                
                // 确保元素可见并模拟原生事件流
                el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });

                const eventOptions = { bubbles: true, cancelable: true, view: window, composed: true };
                try {
                    el.dispatchEvent(new MouseEvent('mouseover', eventOptions));
                    el.dispatchEvent(new MouseEvent('mousedown', eventOptions));
                    el.dispatchEvent(new MouseEvent('mouseup', eventOptions));
                    el.dispatchEvent(new MouseEvent('click', eventOptions));
                } catch (e) {
                    el.click(); // 兜底使用原生方法
                }
                return `已点击 ID=${id} 的元素 (${el.tagName})`;
            }
          });
          clickResult = clickRes[0]?.result || clickResult;

          // 等待潜在的页面跳转
          await new Promise(r => setTimeout(r, 2000));
          
          const [postClickTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const newUrl = postClickTab.url;

          if (oldUrl !== newUrl) {
              await waitForPageLoad(postClickTab.id);
              const newPageContent = await readActiveTabContent(postClickTab.id);
              return `${clickResult}。页面已跳转: ${newUrl}。\n\n${newPageContent}`;
          }
          return `${clickResult}`;
        } finally {
            setIsAgentTabSwitch(false);
        }
      }

      case "type_text": {
        setIsAgentTabSwitch(true);
        try {
          const typeRes = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            args: [args.element_id, args.text, args.press_enter === true], 
            func: (id, text, pressEnter) => {
              try {
                const el = document.querySelector(`[data-agent-id="${id}"]`);
                if (!el) return `错误: 未找到 ID=${id} 的输入框`;
                el.focus();
                
                // 处理可编辑 DIV 和标准输入框
                const isEditable = el.isContentEditable;
                if (isEditable && !['INPUT', 'TEXTAREA'].includes(el.tagName)) {
                    el.innerText = text;
                } else {
                    const prototype = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
                    if (setter) { setter.call(el, text); } else { el.value = text; }
                }

                // 触发输入事件以通知现代前端框架（React/Vue）
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));

                if (pressEnter) {
                    const keyOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
                    el.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
                    el.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
                    // 尝试寻找提交按钮
                    const form = el.closest('form');
                    const submitBtn = (form && form.querySelector('button, [type="submit"]')) || 
                                     document.querySelector('.nav-search-btn, [class*="send-btn"]');
                    if (submitBtn) setTimeout(() => submitBtn.click(), 150);
                }
                return `文本注入完成`;
              } catch (e) { return `执行失败: ${e.message}`; }
            }
          });
          return typeRes[0]?.result || "指令发送成功";
        } finally { setIsAgentTabSwitch(false); }
      }

      case "analyze_screenshot": {
        await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, func: DOM_SNAPSHOT_SCRIPT });
        await new Promise(r => setTimeout(r, 200));
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 60 });
        if (!dataUrl) return "错误：无法捕捉当前视口截图。";
        return await callVisionAPI(dataUrl, args.target_description);
      }
      
      case "web_search": {
          const q = encodeURIComponent(args.query);
          const url = `https://www.bing.com/search?q=${q}`;
          try {
              const res = await fetch(url, {
                  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
              });
              if (!res.ok) return `搜索请求失败 (HTTP ${res.status})`;
              const htmlText = await res.text();
              const parser = new DOMParser();
              const doc = parser.parseFromString(htmlText, "text/html");
              const results = [];
              doc.querySelectorAll('li.b_algo').forEach((el, i) => {
                  if (results.length >= 5) return;
                  const titleEl = el.querySelector('h2 a');
                  if (titleEl) {
                      results.push(`[${i+1}] ${titleEl.innerText}\n链接: ${titleEl.href}`);
                  }
              });
              return results.length > 0 ? results.join('\n\n') : "未找到相关搜索结果。";
          } catch (e) { return `搜索异常: ${e.message}`; }
      }

      case "fetch_url_content": {
          try {
              const res = await fetch(args.url, {
                  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
              });
              if (!res.ok) return `抓取失败 (HTTP ${res.status})`;
              const htmlText = await res.text();
              const doc = new DOMParser().parseFromString(htmlText, "text/html");
              const text = doc.body.innerText.replace(/\s+/g, ' ').substring(0, config.maxContextChars || 15000);
              return `标题: ${doc.title}\n内容摘要: ${text}`;
          } catch (e) { return `页面抓取异常: ${e.message}`; }
      }

      default: return `未知工具指令: ${name}`;
    }
  } catch (err) { 
    console.error("执行器运行异常:", err);
    return `执行器内部错误: ${err.message}`; 
  }
}

/**
 * 重置页面视觉覆盖层
 */
export async function clearPageOverlays() {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && !tabs[0].url.startsWith('chrome')) {
            await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: CLEAR_OVERLAY_SCRIPT });
        }
    } catch(e) {}
}
