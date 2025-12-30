/**
 * Agent 扩展工具定义映射表 (OpenAI Tool Specification 格式)
 * 定义了 AI 能够调用的所有浏览器操作指令及其参数规范
 */
export const browserTools = [
  {
    type: "function",
    function: {
      name: "get_page_interactables",
      description: "获取当前页面可交互元素的快照（包含元素 ID 与标签）。在执行点击或输入操作前必须调用此工具以确认目标 ID。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "read_page_content",
      description: "提取并返回当前页面的主要文本内容。用于基于页面信息进行问答、总结或深度分析。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "click_element",
      description: "模拟鼠标点击指定的页面元素。需要精确提供通过 get_page_interactables 获取的 element_id。",
      parameters: {
        type: "object",
        properties: {
          element_id: { 
            type: "integer", 
            description: "目标元素的唯一数字 ID" 
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
      description: "在指定输入框中注入文本。支持模拟回车操作以触发搜索或提交行为。",
      parameters: {
        type: "object",
        properties: {
          element_id: { type: "integer", description: "目标输入框的唯一数字 ID" },
          text: { type: "string", description: "待注入的字符串内容" },
          press_enter: { type: "boolean", description: "注入完成后是否模拟按下回车键", default: false }
        },
        required: ["element_id", "text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "在浏览器中打开新的 URL 链接。AI 会自动导航至该页面并等待加载完成。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "完整的网址协议头 (http/https)" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyze_screenshot",
      description: "视觉辅助分析工具。当 DOM 识别失效或页面布局极其复杂时调用。该工具会生成带编号的截图并由视觉模型辅助定位目标 ID。",
      parameters: {
        type: "object",
        properties: {
          target_description: { 
            type: "string", 
            description: "描述你希望寻找的元素特征及大致方位" 
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
      description: "外部搜索引擎接入（Bing）。当当前页面无法提供所需信息或需要检索最新事实时使用。",
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
      description: "跨域抓取指定链接的内容摘要。常用于搜索结果的深度阅读，此操作不会在 UI 上切换用户当前的活动标签页。",
      parameters: {
        type: "object",
        properties: {
          url: { 
            type: "string", 
            description: "待解析的完整网页链接" 
          }
        },
        required: ["url"]
      }
    }
  }
];
