import { DOM_SNAPSHOT_SCRIPT, CLEAR_OVERLAY_SCRIPT } from './domAgent.js';
import { requestUserApproval } from './ui.js';
import { getApprovalSetting, setGlobalApprovalSetting, config, setIsAgentTabSwitch } from './state.js';

/** 等待页面加载完成 */
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
        return new Promise(resolve => setTimeout(resolve, 1000)); 
    } catch(e) { 
        console.warn("waitForPageLoad failed:", e.message);
        return; 
    }
}

/** 读取当前标签页内容 */
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
        return readRes?.[0]?.result || "无法读取新页面的内容。";
    } catch (e) {
        console.error("readActiveTabContent failed:", e);
        return `读取页面内容时发生错误: ${e.message}`;
    }
}

/**
 * 调用视觉模型 API
 */
async function callVisionAPI(base64Image, targetDescription) {
    if (!config.visionApiKey) {
        return "错误：未配置视觉模型 API Key。请在设置中配置。";
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
                        content: `你是一个极其精准的网页视觉分析助手，专门负责从带有红色ID标记的截图中提取元素ID。

# 任务
根据用户的文字描述，在图片中找到对应的元素，并返回该元素旁边红色标记里的数字。

# ID 标记的特征
-   它是一个小的红色实心矩形。
-   里面有一个白色的数字。
-   它在所标识的元素的红色边框左上角。

# 关键规则
-   你必须忽略页面本身的所有其他数字，比如点赞数、评论数、价格等。它们是**内容**，**不是ID**。
-   你的回答必须简洁、准确，只返回ID数字。

# 示例

---
**用户输入:**
-   文字描述: "请帮我找到右上角的'登录'按钮"
-   (附加一张图片，图片中'登录'按钮被一个红色边框包裹，边框左上角有一个红色标记，里面写着'42')

**你的正确回答:**
我找到了登录按钮，这个按钮对应的id是42。
---

现在，请处理用户的实际请求。`
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: `请找到这个元素：${targetDescription}。它对应的红色数字ID是多少？` },
                            {
                                type: "image_url",
                                image_url: {
                                    url: base64Image,
                                    detail: "high"
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 300
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`视觉 API 请求失败: ${response.status} - ${errText}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || "无返回内容";
        return `视觉模型分析结果：${content}`;

    } catch (e) {
        console.error("Vision API Error:", e);
        return `调用视觉模型失败: ${e.message}`;
    }
}


/**
 * 核心工具执行器
 */
export async function executeTool(name, args) {
  try {
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
    if (!activeTab) return "错误: 无活跃标签页";

    switch (name) {
      case "open_url":
        setIsAgentTabSwitch(true);
        try {
            const newTab = await chrome.tabs.create({ url: args.url, active: true });
            await waitForPageLoad(newTab.id);
            const newPageContent = await readActiveTabContent(newTab.id);
            return `已成功打开网址: ${args.url}. ${newPageContent}`;
        } finally { 
            setIsAgentTabSwitch(false); 
        }

      case "get_page_interactables":
        await waitForPageLoad(activeTab.id);
        const snapshotRes = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: DOM_SNAPSHOT_SCRIPT
        });
        if (!snapshotRes?.[0]?.result) return "错误: 无法扫描页面交互元素。";
        return snapshotRes[0].result.elements;

      case "read_page_content":
        await waitForPageLoad(activeTab.id);
        return await readActiveTabContent(activeTab.id);
      
      case "click_element": {
        setIsAgentTabSwitch(true);
        let clickResult = "点击指令无返回结果";
        try {
          const [preClickTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const oldUrl = preClickTab.url;

          const clickRes = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            args: [args.element_id],
            func: (id) => {
                const el = document.querySelector(`[data-agent-id="${id}"]`);
                if (!el) return `错误: 未找到 ID=${id} 的元素`;
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.click();
                return `已点击 ID=${id} 的元素 (${el.tagName})。`;
            }
          });
          clickResult = clickRes[0]?.result || clickResult;

          await new Promise(r => setTimeout(r, 2000));
          
          const [postClickTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const newUrl = postClickTab.url;

          if (oldUrl !== newUrl) {
              await waitForPageLoad(postClickTab.id);
              const newPageContent = await readActiveTabContent(postClickTab.id);
              return `${clickResult} 页面已跳转至: ${newUrl}。\n\n${newPageContent}`;
          } else {
              return `${clickResult}`;
          }

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
                const isEditable = el.hasAttribute('contenteditable') || el.contentEditable === 'true' || el.tagName === 'DIV' || el.tagName === 'SPAN';
                if (isEditable && !['INPUT', 'TEXTAREA'].includes(el.tagName)) {
                    el.innerText = text;
                } else {
                    const prototype = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
                    if (setter) { setter.call(el, text); } else { el.value = text; }
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                if (pressEnter) {
                    const keyOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
                    el.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
                    el.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
                    el.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
                    const form = el.closest('form');
                    const submitBtn = (form && form.querySelector('button, [type="submit"]')) || 
                                     document.querySelector('.nav-search-btn, [class*="send-btn"], [class*="SendBtn"]');
                    if (submitBtn) {
                        setTimeout(() => submitBtn.click(), 150);
                        return `文本已注入，且已模拟回车及点击发送按钮`;
                    }
                }
                return `文本注入完成`;
              } catch (innerError) { return `注入过程崩溃: ${innerError.message}`; }
            }
          });
          await new Promise(r => setTimeout(r, 800)); 
          return typeRes[0]?.result || "脚本注入无返回结果";
        } finally { setIsAgentTabSwitch(false); }
      }

      // 视觉分析工具
      case "analyze_screenshot": {
        await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: DOM_SNAPSHOT_SCRIPT
        });
        
        await new Promise(r => setTimeout(r, 150));

        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 60 });
        
        if (!dataUrl) return "错误：无法截取屏幕。";

        return await callVisionAPI(dataUrl, args.target_description);
      }
      
      case "web_search": {
          const q = encodeURIComponent(args.query);
          const url = `https://www.bing.com/search?q=${q}`;
          
          try {
              // 添加 User-Agent 伪装，确保 Bing 返回 PC 版页面
              const res = await fetch(url, {
                  headers: {
                      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                  }
              });

              if (!res.ok) {
                  return `Bing 搜索请求失败: ${res.status}`;
              }
              const htmlText = await res.text();
              
              const parser = new DOMParser();
              const doc = parser.parseFromString(htmlText, "text/html");
              
              let resultElements = doc.querySelectorAll('li.b_algo');
              
              if (resultElements.length === 0) {
                  resultElements = doc.querySelectorAll('#b_results > li');
              }

              if (resultElements.length === 0) {
                  resultElements = doc.querySelectorAll('.b_algo, .b_ans'); 
              }
              
              const results = [];
              const maxResults = 5;
              
              const extractData = (el) => {
                  const titleEl = el.querySelector('h2 a, .b_title a');
                  if (!titleEl) return null;
                  
                  const title = titleEl.innerText.trim();
                  const link = titleEl.href;
                  if (!link || link.startsWith('javascript')) return null;

                  const clone = el.cloneNode(true);
                  
                  // 移除干扰元素
                  const metaSelectors = [
                      'style', 'script', 'svg', 'path', 'h2', 'h3', 'header', 
                      '.b_attribution', '.b_cite', '.b_algoheader', 
                      '.b_overflow', '.b_actions', '.b_contextmenu', '.b_header_action', 
                      '.b_ad', '.b_expando', '.b_check'
                  ];
                  metaSelectors.forEach(sel => {
                      clone.querySelectorAll(sel).forEach(n => n.remove());
                  });
                  
                  const blockTags = ['div', 'p', 'li', 'br', 'ul', 'ol', 'section'];
                  blockTags.forEach(tag => {
                      clone.querySelectorAll(tag).forEach(node => {
                          node.innerHTML = ` ${node.innerHTML} `;
                          if (tag === 'br') node.replaceWith('\n');
                      });
                  });

                  let snippet = clone.textContent;
                  
                  snippet = snippet.replace(/[\s\u3000]+/g, ' ').trim();
                  
                  snippet = snippet.replace(/^[·\-\s\d\w]+(\d{4}年\d{1,2}月\d{1,2}日)?[·\-\s]+/, '');
                  
                  if (snippet.length < 5) { 
                      snippet = "无摘要";
                  }

                  return { title, link, snippet };
              };

              for (let i = 0; i < resultElements.length; i++) {
                  if (results.length >= maxResults) break;
                  const data = extractData(resultElements[i]);
                  if (data) {
                      results.push(`[${results.length + 1}] ${data.title}\n链接: ${data.link}\n摘要: ${data.snippet}\n`);
                  }
              }

              if (results.length === 0) {
                   const genericResults = doc.querySelectorAll('h2 a');
                   if (genericResults.length > 0) {
                       genericResults.forEach((a) => {
                           if (results.length >= maxResults) return;
                           const title = a.innerText.trim();
                           const link = a.href;
                           if (title && link && link.startsWith('http') && !link.includes('microsoft.com/')) { 
                               results.push(`[${results.length + 1}] ${title}\n链接: ${link}\n(自动提取的备用结果)\n`);
                           }
                       });
                   }
              }
              
              if (results.length === 0) {
                   // 调试信息：如果还是失败，返回一点 HTML 结构片段帮忙 Debug (截取前500字符)
                   // const debugSnippet = htmlText.substring(0, 500).replace(/</g, '&lt;');
                   return `未能解析出关于 "${args.query}" 的有效结果。请尝试更换关键词。`;
              }

              return `关于 "${args.query}" 的 Bing 搜索结果:\n\n${results.join('\n----------------\n')}`;
              
          } catch (e) {
              return `搜索请求发生错误: ${e.message}`;
          }
      }

      case "fetch_url_content": {
          try {
              if (!args.url || !args.url.startsWith('http')) {
                  return "错误: 无效的 URL。";
              }

              const res = await fetch(args.url, {
                  method: 'GET',
                  redirect: 'follow',
                  headers: {
                      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                  }
              });

              if (!res.ok) {
                  return `获取网页失败: HTTP ${res.status} ${res.statusText}`;
              }

              const htmlText = await res.text();
              const parser = new DOMParser();
              const doc = parser.parseFromString(htmlText, "text/html");

              const trashSelectors = [
                  'script', 'style', 'noscript', 'iframe', 'svg', 'header', 'footer', 'nav', 
                  '.ad', '.ads', '.advertisement', '#sidebar', '.sidebar'
              ];
              trashSelectors.forEach(sel => {
                  doc.querySelectorAll(sel).forEach(el => el.remove());
              });

              const title = doc.title.trim() || "无标题";
              let text = doc.body.innerText || "";
              text = text.replace(/[\r\n]+/g, '\n').replace(/\s+/g, ' ').trim();
              
              const maxLength = config.maxContextChars || 15000;
              if (text.length > maxLength) {
                  text = text.substring(0, maxLength) + "\n... (内容过长已截断)";
              }

              return `网页标题: ${title}\nURL: ${res.url}\n\n内容摘要:\n${text}`;

          } catch (e) {
              return `后台抓取网页失败: ${e.message}`;
          }
      }

      default: return `未知工具指令: ${name}`;
    }
  } catch (err) { 
    console.error("Executor Tool Error:", err);
    return `工具执行系统级错误: ${err.message}`; 
  }
}

/**
 * 清理页面上的红色 ID 标记
 */
export async function clearPageOverlays() {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && !tabs[0].url.startsWith('chrome')) {
            await chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                func: CLEAR_OVERLAY_SCRIPT
            });
        }
    } catch(e) {}
}