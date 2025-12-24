import { browserTools } from './tools.js';

export let sessions = {}; 
export let currentSessionId = null;
export let presets = []; 

const initialEnabledTools = {};
browserTools.forEach(tool => {
  initialEnabledTools[tool.function.name] = true;
});

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

export let autoPerm = false;
export let autoTemp = false;
export let currentController = null;
export let tempContexts = [];
export let isGenerating = false;
export let editingMessageId = null; 
export let isAgentTabSwitch = false;
export let isAgentModeActive = false;

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

export function saveStorage() {
  chrome.storage.local.set({ 
    config, sessions, currentSessionId, presets, autoPerm, autoTemp
  });
}

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

function ensureApprovalStructure(session) {
    if (!session.approvalSettings) {
        session.approvalSettings = { session: {}, turn: {}, isSessionApproved: false, isTurnApproved: false };
    }
    if (session.approvalSettings.isSessionApproved === undefined) session.approvalSettings.isSessionApproved = false;
    if (session.approvalSettings.isTurnApproved === undefined) session.approvalSettings.isTurnApproved = false;
}

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

export function setApprovalSetting(toolName, scope) {
    const session = sessions[currentSessionId];
    if (!session) return;
    ensureApprovalStructure(session);
    if (scope === 'session') session.approvalSettings.session[toolName] = true;
    if (scope === 'turn') session.approvalSettings.turn[toolName] = true;
    saveStorage();
}

export function clearTurnApprovals() {
    const session = sessions[currentSessionId];
    if (session && session.approvalSettings) {
        session.approvalSettings.turn = {};
        session.approvalSettings.isTurnApproved = false;
        saveStorage();
    }
}

export function switchSession(id) {
  if (sessions[id]) {
    currentSessionId = id;
    saveStorage();
  }
}

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

export function updateCurrentSessionTitle(text) {
  const session = sessions[currentSessionId];
  if (!session) return;
  const userMessages = session.messages.filter(m => m.role === 'user');
  if (userMessages.length === 1) {
    session.title = text.substring(0, 25) || "新对话";
    saveStorage();
  }
}

export function addMessage(message) {
    if(sessions[currentSessionId]) {
        sessions[currentSessionId].messages.push(message);
        saveStorage();
    }
}

export function updateMessageById(id, updates) {
    if (!sessions[currentSessionId]) return;
    const session = sessions[currentSessionId];
    const msgIndex = session.messages.findIndex(m => m.id === id);
    if (msgIndex !== -1) {
        session.messages[msgIndex] = { ...session.messages[msgIndex], ...updates };
        saveStorage();
    }
}

export function removeMessageByIndex(index) {
    if(sessions[currentSessionId]) {
        sessions[currentSessionId].messages.splice(index, 1);
        saveStorage();
    }
}

export function replaceMessages(newMessages) {
    if(sessions[currentSessionId]) {
        sessions[currentSessionId].messages = newMessages;
        saveStorage();
    }
}

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

export function removeTempContextByIndex(index) {
    if (tempContexts[index]) {
        tempContexts.splice(index, 1);
    }
}