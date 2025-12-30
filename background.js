// 点击图标打开侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "summarize_page",
    title: "一键总结网页",
    contexts: ["page"]
  });
});

// 处理右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "summarize_page") {
    // 首先打开侧边栏 (Chrome 116+)
    chrome.sidePanel.open({ tabId: tab.id });
    
    // 给侧边栏发送消息，稍微延迟一下确保侧边栏已经加载好
    setTimeout(() => {
      chrome.runtime.sendMessage({
        action: "SUMMARIZE_PAGE",
        tabId: tab.id
      });
    }, 500);
  }
});