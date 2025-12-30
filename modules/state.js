import { browserTools } from './tools.js';

/**
 * 全局状态管理模块
 * 负责应用配置、会话数据、持久化存储及 Agent 工作流标记
 */

export let sessions = {};               // 历史会话集合
export let currentSessionId = null;     // 当前激活的会话 ID
export let presets = [];                // 用户自定义配置预设

// 初始化工具启用状态，默认全部开启
const initialEnabledTools = {};
browserTools.forEach(tool => {
  initialEnabledTools[tool.function.name] = true;
});

// 应用核心配置
export let config = {
  apiUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
  apiKey: "",
  model: "moonshotai/kimi-k2-thinking",
  systemPrompt: `你是一个浏览器自动化代理。\n{{TOOLS_PROMPT}}`,
  temperature: 1.0,
  top_p: 1.0,
  customJson: "",
  maxContextChars: 50000,
  uiTruncateLimit: 2000,
  injectedUserContext: "",
  injectedAssistantContext: "",
  summaryPrompt: "请帮我总结一下这个网页的核心内容，要求：\n1. 简洁明了，使用中文。\n2. 包含核心观点、关键词和主要结论。\n3. 以 Markdown 列表形式呈现。",
  quickCommands: [
    { label: "📝 总结网页", value: "请总结当前网页内容", useTemp: true },
    { label: "🔍 解释术语", value: "请解释网页中的核心专业术语", useTemp: true },
    { label: "💡 提取观点", value: "请提取文中的主要观点和论据", useTemp: true }
  ],

  // 视觉模型专用配置（用于 DOM 识别兜底）
  visionApiUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
  visionApiKey: "",
  visionModel: "mistralai/mistral-large-3-675b-instruct-2512",

  enabledTools: initialEnabledTools,
  toolsPrompt: `策略：
1. 如果用户让你打开某个网站，直接调用 open_url。
2. 调用 get_page_interactables 观察页面。
3. 获得 ID 后执行操作。
4. 如果通过 get_page_interactables 找不到合适的元素，或者页面布局复杂，你可以调用 analyze_screenshot 请求视觉模型帮助你识别元素ID。`
};

export let autoPerm = false;            // 是否自动附加永久上下文
export let autoTemp = false;            // 是否自动附加临时上下文
export let currentController = null;    // 控制请求中断的 AbortController
export let tempContexts = [];           // 待发送的临时上下文队列
export let isGenerating = false;        // LLM 是否正在生成
export let editingMessageId = null;     // 当前正在编辑的消息 ID
export let isAgentTabSwitch = false;    // 是否为 Agent 触发的标签页切换
export let isAgentModeActive = false;   // 当前是否处于 Agent 自动化执行模式

// 状态更新器 (Setters)
export function setSessions(newSessions) { sessions = newSessions; }
export function setCurrentSessionId(newId) { currentSessionId = newId; }
export function setPresets(newPresets) { presets = newPresets; }
export function setConfig(newConfig) { config = { ...config, ...newConfig }; }
export function setAutoPerm(value) { autoPerm = value; }
export function setAutoTemp(value) { autoTemp = value; }
export function setCurrentController(controller) { currentController = controller; }
export function setTempContexts(contexts) { tempContexts = contexts; }
export function setIsGenerating(generating) { isGenerating = generating; }
export function setEditingMessageId(id) { editingMessageId = id; }
export function setIsAgentTabSwitch(value) { isAgentTabSwitch = value; }
export function setIsAgentModeActive(value) { isAgentModeActive = value; }

/**
 * 同步当前配置与数据到 Chrome 本地存储
 */
export function saveStorage() {
  chrome.storage.local.set({
    config, sessions, currentSessionId, presets, autoPerm, autoTemp
  });
}

/**
 * 初始化新会话及其权限设置
 */
export function createNewSession() {
  const newId = Date.now().toString();
  sessions[newId] = {
    title: "新对话",
    timestamp: Date.now(),
    messages: [],
    approvalSettings: {
        session: {},
        turn: {},
        isSessionApproved: false,
        isTurnApproved: false
    }
  };
  currentSessionId = newId;
  saveStorage();
  return newId;
}

/**
 * 确保会话结构包含权限校验逻辑所需的字段
 */
function ensureApprovalStructure(session) {
    if (!session.approvalSettings) {
        session.approvalSettings = { session: {}, turn: {}, isSessionApproved: false, isTurnApproved: false };
    }
    if (session.approvalSettings.isSessionApproved === undefined) session.approvalSettings.isSessionApproved = false;
    if (session.approvalSettings.isTurnApproved === undefined) session.approvalSettings.isTurnApproved = false;
}

/**
 * 获取特定工具的执行授权状态
 */
export function getApprovalSetting(toolName) {
    const session = sessions[currentSessionId];
    if (!session) return null;
    ensureApprovalStructure(session);

    if (session.approvalSettings.isSessionApproved) return 'session';
    if (session.approvalSettings.isTurnApproved) return 'turn';

    if (session.approvalSettings.session[toolName]) return 'session';
    if (session.approvalSettings.turn[toolName]) return 'turn';

    return null;
}

/**
 * 设置全局/范围授权
 */
export function setGlobalApprovalSetting(scope) {
    const session = sessions[currentSessionId];
    if (!session) return;
    ensureApprovalStructure(session);
    
    if (scope === 'session') {
        session.approvalSettings.isSessionApproved = true;
    } else if (scope === 'turn') {
        session.approvalSettings.isTurnApproved = true;
    }
    saveStorage();
}

/**
 * 为特定工具配置授权范围
 */
export function setApprovalSetting(toolName, scope) {
    const session = sessions[currentSessionId];
    if (!session) return;
    ensureApprovalStructure(session);
    if (scope === 'session') session.approvalSettings.session[toolName] = true;
    if (scope === 'turn') session.approvalSettings.turn[toolName] = true;
    saveStorage();
}

/**
 * 重置“本轮”授权标记（通常在用户发送新消息时触发）
 */
export function clearTurnApprovals() {
    const session = sessions[currentSessionId];
    if (session && session.approvalSettings) {
        session.approvalSettings.turn = {};
        session.approvalSettings.isTurnApproved = false;
        saveStorage();
    }
}

/**
 * 会话切换逻辑
 */
export function switchSession(id) {
  if (sessions[id]) {
    currentSessionId = id;
    saveStorage();
  }
}

/**
 * 删除会话并自动调整当前活跃会话
 */
export function deleteSessionById(id) {
    if (sessions[id]) {
        delete sessions[id];
        if (currentSessionId === id) {
          const keys = Object.keys(sessions).sort((a,b) => sessions[b].timestamp - sessions[a].timestamp);
          if (keys.length > 0) {
            currentSessionId = keys[0];
          } else {
            createNewSession();
          }
        }
        saveStorage();
    }
}

/**
 * 根据第一条用户消息自动生成会话标题
 */
export function updateCurrentSessionTitle(text) {
  const session = sessions[currentSessionId];
  if (!session) return;
  const userMessages = session.messages.filter(m => m.role === 'user');
  if (userMessages.length === 1) {
    session.title = text.substring(0, 25) || "新对话";
    saveStorage();
  }
}

/**
 * 向当前会话追加消息记录
 */
export function addMessage(message) {
    if(sessions[currentSessionId]) {
        sessions[currentSessionId].messages.push(message);
        saveStorage();
    }
}

/**
 * 根据 ID 更新特定消息的内容（如流式输出或工具返回结果）
 */
export function updateMessageById(id, updates) {
    if (!sessions[currentSessionId]) return;
    const session = sessions[currentSessionId];
    const msgIndex = session.messages.findIndex(m => m.id === id);
    if (msgIndex !== -1) {
        session.messages[msgIndex] = { ...session.messages[msgIndex], ...updates };
        saveStorage();
    }
}

/**
 * 删除指定索引的消息
 */
export function removeMessageByIndex(index) {
    if(sessions[currentSessionId]) {
        sessions[currentSessionId].messages.splice(index, 1);
        saveStorage();
    }
}

/**
 * 全量替换当前会话的消息列表（常用于重试逻辑）
 */
export function replaceMessages(newMessages) {
    if(sessions[currentSessionId]) {
        sessions[currentSessionId].messages = newMessages;
        saveStorage();
    }
}

/**
 * 清空当前会话所有消息并重置权限设置
 */
export function clearCurrentSessionMessages() {
    if (sessions[currentSessionId]) {
        sessions[currentSessionId].messages = [];
        ensureApprovalStructure(sessions[currentSessionId]);
        sessions[currentSessionId].approvalSettings.session = {};
        sessions[currentSessionId].approvalSettings.turn = {};
        sessions[currentSessionId].approvalSettings.isSessionApproved = false;
        sessions[currentSessionId].approvalSettings.isTurnApproved = false;
        saveStorage();
    }
}

/**
 * 移除临时附件队列中的指定项
 */
export function removeTempContextByIndex(index) {
    if (tempContexts[index]) {
        tempContexts.splice(index, 1);
    }
}
