export const browserTools = [
  {
    type: "function",
    function: {
      name: "get_page_interactables",
      description: "获取当前网页的交互元素快照。仅当你需要点击按钮(click_element)或输入文本(type_text)但不知道元素ID时调用。如果你只是想打开新网页，不需要调用此函数。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "read_page_content",
      description: "读取当前网页的主要文本内容。当你觉得找不到合适的按钮，或者需要基于网页内容回答问题时使用此工具。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "click_element",
      description: "点击网页上的某个元素。必须提供从 get_page_interactables 获取的准确 ID。",
      parameters: {
        type: "object",
        properties: {
          element_id: { 
            type: "integer", 
            description: "要点击的元素ID (例如: 12)" 
          }
        },
        required: ["element_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "在输入框中输入文本。必须提供从 get_page_interactables 获取的准确 ID。",
      parameters: {
        type: "object",
        properties: {
          element_id: { type: "integer", description: "输入框元素的ID" },
          text: { type: "string", description: "要输入的文本内容" },
          press_enter: { type: "boolean", description: "输入后是否按回车键", default: false }
        },
        required: ["element_id", "text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "在新标签页中打开一个网址。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "完整的URL地址 (必须以 http:// 或 https:// 开头)" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyze_screenshot",
      description: "当你在 DOM 树中找不到想要的元素，或者页面布局太复杂无法判断时，调用此工具。它会截取当前屏幕（包含视觉上的ID标记），并用视觉模型帮你寻找目标元素的 ID。描述应尽可能清晰，不要在不确定的时候假定某个图标可能是长什么样的，如指定'右下角的爱心图标'，正确请求是'右下角的点赞图标'（如果用户指定要求的是点赞图标）",
      parameters: {
        type: "object",
        properties: {
          target_description: { 
            type: "string", 
            description: "描述你要找的元素。例如：'右上角的登录按钮' 或 'xxx下方的点赞按钮'。" 
          }
        },
        required: ["target_description"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "使用 Bing 搜索来获取网络上的信息。当无法通过阅读当前页面解决问题，或需要外部知识时使用。",
      parameters: {
        type: "object",
        properties: {
          query: { 
            type: "string", 
            description: "搜索关键词" 
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_url_content",
      description: "在后台获取指定 URL 的网页纯文本内容。用于 web_search 搜索后，进一步读取感兴趣的网页详情。此工具不会切换用户当前的标签页。",
      parameters: {
        type: "object",
        properties: {
          url: { 
            type: "string", 
            description: "要读取的网页链接 (URL)" 
          }
        },
        required: ["url"]
      }
    }
  }
];