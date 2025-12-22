// modules/domAgent.js

export const DOM_SNAPSHOT_SCRIPT = () => {
    try {
        const OVERLAY_ID = '__hapemxg_copilot_overlay__';
        const MAX_ELEMENTS = 400; // 熔断限制

        // 1. 清理旧标记
        const oldOverlay = document.getElementById(OVERLAY_ID);
        if (oldOverlay) oldOverlay.remove();
        document.querySelectorAll('[data-agent-id]').forEach(el => el.removeAttribute('data-agent-id'));

        // 2. 视口检查
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;

        const isVisible = (el, rect) => {
            try {
                const style = window.getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') return false;
                if (rect.width < 3 || rect.height < 3) return false;
                
                const buffer = viewportHeight * 0.5; 
                if (rect.bottom < -buffer || rect.top > viewportHeight + buffer) return false;
                if (rect.right < 0 || rect.left > viewportWidth) return false;
                return true;
            } catch (e) {
                return false; // 如果样式获取失败，视为不可见
            }
        };

        const getLabel = (el) => {
            let label = el.getAttribute('aria-label') || 
                        el.getAttribute('placeholder') || 
                        el.title || el.value || "";
            if (!label && (el.isContentEditable || el.getAttribute('contenteditable') === 'true')) label = "[输入框]";
            if (!label) label = el.innerText.replace(/\s+/g, ' ').trim();
            return label.substring(0, 50);
        };

        // 3. 安全创建覆盖层
        if (!document.body) throw new Error("Document body not found");
        
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0',
            width: '100vw', height: '100vh',
            zIndex: '2147483647', pointerEvents: 'none'
        });
        document.body.appendChild(overlay);

        const selector = 'a, button, input, textarea, select, details, summary, [contenteditable="true"], [role="button"], [role="link"], [onclick], [tabindex], div, span';
        const potentialElements = document.querySelectorAll(selector);
        
        const validEntries = [];
        let count = 0;

        for (let i = 0; i < potentialElements.length; i++) {
            if (count >= MAX_ELEMENTS) break;

            const el = potentialElements[i];
            
            // 增加 try-catch 防止单个元素属性获取失败导致脚本崩溃
            try {
                const rect = el.getBoundingClientRect();
                if (!isVisible(el, rect)) continue;

                const tagName = el.tagName.toLowerCase();
                if (['div', 'span'].includes(tagName)) {
                    const style = window.getComputedStyle(el);
                    const hasPointer = style.cursor === 'pointer';
                    const hasClick = el.getAttribute('onclick') || el.getAttribute('role') || el.getAttribute('tabindex');
                    const isEditable = el.isContentEditable;
                    if (!hasPointer && !hasClick && !isEditable && !getLabel(el)) continue;
                }

                let label = getLabel(el);
                const isInput = ['input', 'textarea', 'select'].includes(tagName) || el.isContentEditable;
                if (!label && !isInput) {
                    if (el.querySelector('img, svg')) label = "[图标]";
                    else continue;
                }

                validEntries.push({ el, rect, label: label || (isInput ? "[输入]" : "[点击]") });
                count++;
            } catch (innerError) {
                // 忽略单个元素的错误，继续扫描下一个
                continue;
            }
        }

        const elementMap = [];
        validEntries.forEach((entry, index) => {
            const { el, rect, label } = entry;
            const id = index + 1;
            el.setAttribute('data-agent-id', id);
            
            const box = document.createElement('div');
            Object.assign(box.style, {
                position: 'absolute',
                top: `${rect.top}px`, left: `${rect.left}px`,
                width: `${rect.width}px`, height: `${rect.height}px`,
                border: '2px solid #ff4757', borderRadius: '4px',
                boxSizing: 'border-box'
            });
            overlay.appendChild(box);

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
        console.error("DOM Snapshot Error:", e);
        // 将具体的错误信息返回给 UI
        return { error: e.toString() };
    }
};

export const CLEAR_OVERLAY_SCRIPT = () => {
    const overlay = document.getElementById('__hapemxg_copilot_overlay__');
    if (overlay) overlay.remove();
    document.querySelectorAll('[data-agent-id]').forEach(el => el.removeAttribute('data-agent-id'));
    return "已清除页面标记";
};