/**
 * 页面交互元素扫描逻辑
 * 注入网页执行，识别、标记并对可交互元素进行编号，生成 DOM 状态快照
 */
export const DOM_SNAPSHOT_SCRIPT = () => {
    try {
        const OVERLAY_ID = '__hapemxg_copilot_overlay__';
        const MAX_ELEMENTS = 400; // 限制单次扫描的最大元素数量，保证性能

        // 清理旧的覆盖层和标记属性
        const oldOverlay = document.getElementById(OVERLAY_ID);
        if (oldOverlay) oldOverlay.remove();
        document.querySelectorAll('[data-agent-id]').forEach(el => el.removeAttribute('data-agent-id'));

        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;

        /**
         *判断元素是否在视觉上可见且具有可交互尺寸
         */
        const isVisible = (el, rect) => {
            try {
                const style = window.getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') return false;
                if (rect.width < 3 || rect.height < 3) return false;
                
                // 允许扫描视口上下半屏宽度的缓冲区内容
                const buffer = viewportHeight * 0.5; 
                if (rect.bottom < -buffer || rect.top > viewportHeight + buffer) return false;
                if (rect.right < 0 || rect.left > viewportWidth) return false;
                return true;
            } catch (e) {
                return false; 
            }
        };

        /**
         * 提取元素的可读标签/描述，优先级：aria-label > placeholder > title > value > innerText
         */
        const getLabel = (el) => {
            let label = el.getAttribute('aria-label') || 
                        el.getAttribute('placeholder') || 
                        el.title || el.value || "";
            if (!label && (el.isContentEditable || el.getAttribute('contenteditable') === 'true')) label = "[输入框]";
            if (!label) label = el.innerText.replace(/\s+/g, ' ').trim();
            return label.substring(0, 50); // 截断过长的描述
        };

        if (!document.body) throw new Error("无法访问页面 body 元素");
        
        // 创建绘图容器覆盖层
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0',
            width: '100vw', height: '100vh',
            zIndex: '2147483647', pointerEvents: 'none'
        });
        document.body.appendChild(overlay);

        // 选择可能具备交互能力的标签或具备特定属性的元素
        const selector = 'a, button, input, textarea, select, details, summary, [contenteditable="true"], [role="button"], [role="link"], [onclick], [tabindex], div, span';
        const potentialElements = document.querySelectorAll(selector);
        
        const validEntries = [];
        let count = 0;

        for (let i = 0; i < potentialElements.length; i++) {
            if (count >= MAX_ELEMENTS) break;

            const el = potentialElements[i];
            
            try {
                const rect = el.getBoundingClientRect();
                if (!isVisible(el, rect)) continue;

                const tagName = el.tagName.toLowerCase();
                // 针对泛类标签 (div, span) 增加额外的启发式判断
                if (['div', 'span'].includes(tagName)) {
                    const style = window.getComputedStyle(el);
                    const hasPointer = style.cursor === 'pointer';
                    const hasClick = el.getAttribute('onclick') || el.getAttribute('role') || el.getAttribute('tabindex');
                    const isEditable = el.isContentEditable;
                    // 如果既没 pointer 也没事件监听，且没有有效文字，则忽略
                    if (!hasPointer && !hasClick && !isEditable && !getLabel(el)) continue;
                }

                let label = getLabel(el);
                const isInput = ['input', 'textarea', 'select'].includes(tagName) || el.isContentEditable;
                
                // 处理仅有图标而无文字的按钮
                if (!label && !isInput) {
                    if (el.querySelector('img, svg')) label = "[图标]";
                    else continue;
                }

                validEntries.push({ el, rect, label: label || (isInput ? "[输入]" : "[点击]") });
                count++;
            } catch (innerError) {
                continue;
            }
        }

        // 渲染视觉标记并构建元素映射表
        const elementMap = [];
        validEntries.forEach((entry, index) => {
            const { el, rect, label } = entry;
            const id = index + 1;
            el.setAttribute('data-agent-id', id); // 注入 ID 供后续执行点击/输入
            
            // 绘制红色高亮边框
            const box = document.createElement('div');
            Object.assign(box.style, {
                position: 'absolute',
                top: `${rect.top}px`, left: `${rect.left}px`,
                width: `${rect.width}px`, height: `${rect.height}px`,
                border: '2px solid #ff4757', borderRadius: '4px',
                boxSizing: 'border-box'
            });
            overlay.appendChild(box);

            // 绘制悬浮数字标签
            const tag = document.createElement('div');
            tag.innerText = id;
            Object.assign(tag.style, {
                position: 'absolute',
                top: `${rect.top}px`, left: `${rect.left}px`,
                transform: 'translateY(-100%)',
                backgroundColor: '#ff4757', color: 'white',
                fontSize: '11px', fontWeight: 'bold', padding: '1px 4px',
                borderRadius: '4px', zIndex: '2147483647',
                whiteSpace: 'nowrap'
            });
            // 边界检查：防止标签超出视口顶部
            if (rect.top < 20) { tag.style.top = `${rect.top}px`; tag.style.transform = 'translateY(0)'; }
            
            overlay.appendChild(tag);
            elementMap.push(`[ID: ${id}] <${el.tagName.toLowerCase()}> "${label}"`);
        });

        return {
            title: document.title,
            url: window.location.href,
            elements: elementMap.join('\n')
        };
    } catch (e) {
        console.error("DOM Snapshot 执行失败:", e);
        return { error: e.toString() };
    }
};

/**
 * 清除页面上所有的 ID 标记及高亮边框
 */
export const CLEAR_OVERLAY_SCRIPT = () => {
    const overlay = document.getElementById('__hapemxg_copilot_overlay__');
    if (overlay) overlay.remove();
    document.querySelectorAll('[data-agent-id]').forEach(el => el.removeAttribute('data-agent-id'));
    return "已清除页面标记";
};
