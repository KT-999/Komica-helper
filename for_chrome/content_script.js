/**
 * Komica Post Saver - Content Script (v1.7.0.0)
 *
 * 變更：
 * 1. 跨瀏覽器相容性 (Firefox / Chrome)。
 * 2. 修復新版 Komica DOM 結構相容性（適應 .post-action-wrap，防止按鈕被插入到 <noscript> 中）。
 * 3. 強化 ID 提取邏輯：支援原生 .id[data-id]、.post-id-menu-toggle 以及從 .now 中動態解析 ID。
 * 4. 新增：NG 關鍵字過濾功能（標題、內文命中自動隱藏/摺疊）。
 * 5. 新增：摺疊提示條模式（可於設定開啟，以提示條取代完全隱藏，點擊即時展開）。
 * 6. 新增：圖片快速搜圖快捷按鈕 (SauceNAO)。
 * 7. 解決隱藏討論串與 NGID 相互覆蓋的問題，防止誤解除隱藏。
 * 8. 強化 MutationObserver 監聽，支援動態載入貼文與元素更新。
 * 9. 貼文預覽過濾掉投票標籤 (.postvote-slot) 與雜訊。
 */

if (typeof browser === 'undefined') {
    var browser = chrome;
}

let currentNgIds = [];
let currentNgKeywords = [];
let savedPostIds = new Set();
let collapseModeEnabled = false;
let imageSearchEnabled = true;

// --- 帶重試的訊息傳送 ---
async function sendMessageWithRetry(message, maxRetries = 3, delay = 100) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await browser.runtime.sendMessage(message);
            if (response !== undefined) return response;
        } catch (error) {
            if (i === maxRetries - 1) {
                console.error(`Komica Helper: Message sending failed after ${maxRetries} retries for action "${message.action}".`, error);
                return { success: false, error: error.message };
            }
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    return { success: false, error: 'Max retries reached' };
}

// --- 訊息監聽 ---
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'updateButtonUI':
            if (message.isSaved) {
                savedPostIds.add(`post-${message.postNo}`);
            } else {
                savedPostIds.delete(`post-${message.postNo}`);
            }
            updateSaveButtonAppearance(message.postNo, message.isSaved);
            break;
        case 'unhideThread':
            unhideElement(`.thread[data-no="${message.threadNo}"]`, '[隱藏此串]');
            break;
        case 'applyNgIdFilter':
            applyNgIdFilter();
            break;
        case 'applyKeywordFilter':
            applyKeywordFilter();
            break;
        case 'unhidePostsByNgId':
            unhidePostsByNgId(message.ngId);
            break;
        case 'reapplyFunctions':
            console.log('收到手動重載指令，重新處理頁面元素...');
            refreshSettings().then(() => {
                processElements();
                applyNgIdFilter();
                applyKeywordFilter();
            });
            break;
    }
    return true;
});

function shouldIgnoreHotkey(event) {
    if (event.defaultPrevented || event.repeat) return true;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true;
    const target = event.target;
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tagName = target.tagName ? target.tagName.toLowerCase() : '';
    return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

function setupHotkeys() {
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'r' && event.key !== 'R') return;
        if (shouldIgnoreHotkey(event)) return;
        console.info('Komica Helper: 偵測到 R 鍵，執行「在目前分頁重載功能」。');
        processElements();
        applyNgIdFilter();
        applyKeywordFilter();
    });
}

// --- ID 解析函式 ---
function getPostId(postElement) {
    if (!postElement) return null;
    const idSpan = postElement.querySelector('.id[data-id]');
    if (idSpan && idSpan.dataset.id) {
        return idSpan.dataset.id;
    }
    const idToggle = postElement.querySelector('.post-id-menu-toggle[data-post-id]');
    if (idToggle && idToggle.dataset.postId) {
        return idToggle.dataset.postId;
    }
    const nowElement = postElement.querySelector('.post-head .now');
    if (nowElement) {
        const match = nowElement.textContent.match(/ID:([A-Za-z0-9./]+)/);
        if (match) return match[1];
    }
    return null;
}

// --- 摺疊提示條控制 ---
function updateElementVisibility(element, shouldHide, reason = '') {
    if (!element) return;
    const noticeClass = 'komica-folded-notice';
    let notice = element.previousElementSibling;
    if (notice && !notice.classList.contains(noticeClass)) {
        notice = null;
    }

    if (shouldHide) {
        element.style.display = 'none';
        if (collapseModeEnabled) {
            if (!notice) {
                notice = document.createElement('div');
                notice.className = `${noticeClass} text-button`;
                notice.style.cssText = 'padding: 4px 8px; margin: 4px 0; background: #eee; border: 1px dashed #bbb; color: #666; font-size: 12px; cursor: pointer; border-radius: 3px;';
                element.before(notice);
            }
            notice.textContent = `[已摺疊此內容 (${reason}) - 點擊展開]`;
            notice.style.display = '';
            notice.onclick = () => {
                const isCurrentlyHidden = element.style.display === 'none';
                element.style.display = isCurrentlyHidden ? '' : 'none';
                notice.textContent = isCurrentlyHidden
                    ? `[已展開內容 (${reason}) - 點擊重新摺疊]`
                    : `[已摺疊此內容 (${reason}) - 點擊展開]`;
            };
        } else if (notice) {
            notice.remove();
        }
    } else {
        if (!element.dataset.hiddenByThread && !element.dataset.hiddenByNgid && !element.dataset.hiddenByKeyword) {
            element.style.display = '';
            if (notice) notice.remove();
        }
    }
}

// --- NGID 過濾 ---
async function applyNgIdFilter() {
    const { success, data: ngIdRecords } = await sendMessageWithRetry({ action: 'getNgIds' });
    if (!success) return;
    currentNgIds = (ngIdRecords || []).map(item => item.id || item);

    document.querySelectorAll('.komica-ngid-btn').forEach(btn => {
        updateNgIdButtonState(btn, btn.dataset.ngid);
    });

    applyNgIdFilterToAllPosts();
}

function unhidePostsByNgId(ngId) {
    currentNgIds = currentNgIds.filter(id => id !== ngId);
    document.querySelectorAll(`[data-hidden-by-ngid="${ngId}"]`).forEach(element => {
        delete element.dataset.hiddenByNgid;
        updateElementVisibility(element, false);
    });
    document.querySelectorAll(`.komica-ngid-btn[data-ngid="${ngId}"]`).forEach(btn => {
        updateNgIdButtonState(btn, ngId);
    });
}

function applyNgIdFilterToElement(postElement) {
    const currentId = getPostId(postElement);
    if (!currentId) return;
    const shouldHide = currentNgIds.includes(currentId);
    let targetElement = postElement.classList.contains('threadpost') ? postElement.closest('.thread') : postElement;
    if (!targetElement) targetElement = postElement;

    if (shouldHide) {
        targetElement.dataset.hiddenByNgid = currentId;
        updateElementVisibility(targetElement, true, `NGID: ${currentId}`);
    } else if (targetElement.dataset.hiddenByNgid === currentId) {
        delete targetElement.dataset.hiddenByNgid;
        updateElementVisibility(targetElement, false);
    }
}

function applyNgIdFilterToAllPosts() {
    document.querySelectorAll('.post').forEach(postElement => {
        applyNgIdFilterToElement(postElement);
    });
}

// --- 關鍵字過濾 ---
async function applyKeywordFilter() {
    const { success, data: keywordRecords } = await sendMessageWithRetry({ action: 'getNgKeywords' });
    if (!success) return;
    currentNgKeywords = (keywordRecords || []).map(item => item.keyword || item);
    applyKeywordFilterToAllPosts();
}

function matchKeyword(text, keyword) {
    if (!text || !keyword) return false;
    // 支援 /regex/i 格式
    if (keyword.startsWith('/') && keyword.lastIndexOf('/') > 0) {
        try {
            const lastSlash = keyword.lastIndexOf('/');
            const pattern = keyword.slice(1, lastSlash);
            const flags = keyword.slice(lastSlash + 1) || 'i';
            const regex = new RegExp(pattern, flags);
            return regex.test(text);
        } catch (e) { }
    }
    return text.toLowerCase().includes(keyword.toLowerCase());
}

function applyKeywordFilterToElement(postElement) {
    if (currentNgKeywords.length === 0) {
        if (postElement.dataset.hiddenByKeyword) {
            delete postElement.dataset.hiddenByKeyword;
            updateElementVisibility(postElement, false);
        }
        return;
    }

    const titleEl = postElement.querySelector('.post-head .title');
    const quoteEl = postElement.querySelector('.quote');
    const fullText = `${titleEl ? titleEl.textContent : ''} ${quoteEl ? quoteEl.textContent : ''}`;

    let matchedKeyword = null;
    for (const kw of currentNgKeywords) {
        if (matchKeyword(fullText, kw)) {
            matchedKeyword = kw;
            break;
        }
    }

    let targetElement = postElement.classList.contains('threadpost') ? postElement.closest('.thread') : postElement;
    if (!targetElement) targetElement = postElement;

    if (matchedKeyword) {
        targetElement.dataset.hiddenByKeyword = matchedKeyword;
        updateElementVisibility(targetElement, true, `關鍵字: ${matchedKeyword}`);
    } else if (targetElement.dataset.hiddenByKeyword) {
        delete targetElement.dataset.hiddenByKeyword;
        updateElementVisibility(targetElement, false);
    }
}

function applyKeywordFilterToAllPosts() {
    document.querySelectorAll('.post').forEach(postElement => {
        applyKeywordFilterToElement(postElement);
    });
}

async function proactiveUpdateReset() {
    const { success, data: savedPosts } = await sendMessageWithRetry({ action: 'getAllPosts' });
    if (!success || !savedPosts || savedPosts.length === 0) return;

    document.querySelectorAll('.thread').forEach(threadElement => {
        const threadNo = threadElement.dataset.no;
        const savedPost = savedPosts.find(p => p.url.includes(`res=${threadNo}`));
        if (savedPost && savedPost.hasUpdate) {
            sendMessageWithRetry({ action: 'clearUpdateFlag', postId: savedPost.id });
        }
    });
}

async function hideStoredThreads() {
    const { success, data: hiddenThreadRecords } = await sendMessageWithRetry({ action: 'getHiddenThreads' });
    const hiddenThreads = (hiddenThreadRecords || []).map(item => item.id || item);
    if (!success || !hiddenThreads || hiddenThreads.length === 0) return;
    applyHiddenThreads(hiddenThreads);
}

async function refreshSavedPostsCache() {
    const { success, data: savedPosts } = await sendMessageWithRetry({ action: 'getAllPosts' });
    if (!success || !savedPosts) return;
    savedPostIds = new Set(savedPosts.map(post => post.id));
}

async function refreshSettings() {
    const settings = await browser.storage.local.get({
        collapseMode: false,
        enableImageSearch: true
    });
    collapseModeEnabled = settings.collapseMode;
    imageSearchEnabled = settings.enableImageSearch;
}

// --- 介面按鈕掛載 ---
function addSaveButtonToPost(postElement) {
    const postNo = postElement.dataset.no;
    if (!postNo) return;
    if (postElement.querySelector('.komica-saver-btn')) return;

    const saveButton = document.createElement('span');
    saveButton.className = 'komica-saver-btn text-button';
    saveButton.style.marginLeft = '5px';
    saveButton.style.cursor = 'pointer';
    saveButton.title = '點擊以儲存或取消儲存此貼文';
    saveButton.dataset.postNo = postNo;
    setSaveButtonAppearance(saveButton, savedPostIds.has(`post-${postNo}`));
    updateSaveButtonState(saveButton, postNo);

    saveButton.addEventListener('click', async () => {
        const threadElement = postElement.closest('.thread');
        if (!threadElement) return;
        const threadNo = threadElement.dataset.no;
        const pathParts = window.location.pathname.split('/');
        const boardPath = pathParts.length > 1 ? `/${pathParts[1]}/` : '/';
        const dedicatedThreadUrl = `${window.location.origin}${boardPath}pixmicat.php?res=${threadNo}`;
        const quoteElement = postElement.querySelector('.quote');
        const titleElement = postElement.querySelector('.post-head .title');
        const title = titleElement && titleElement.innerText.trim() !== '無題' ? titleElement.innerText.trim() : `No.${postNo}`;

        let previewText = '沒有內文';
        if (quoteElement) {
            const clone = quoteElement.cloneNode(true);
            clone.querySelectorAll('.postvote-slot, script, style').forEach(el => el.remove());
            previewText = (clone.innerText || clone.textContent || '').trim().substring(0, 150);
            previewText = previewText.replace(/>>\d+/g, '').replace(/[▲▼]\d+/g, '').trim();
            if (!previewText) previewText = '沒有內文';
        }

        const replies = threadElement.querySelectorAll('.post.reply');
        const lastReply = replies.length > 0 ? replies[replies.length - 1] : null;
        const lastReplyNo = lastReply ? parseInt(lastReply.dataset.no, 10) : parseInt(threadNo, 10);
        const postData = {
            id: `post-${postNo}`, postNo, url: dedicatedThreadUrl, title, preview: previewText,
            timestamp: new Date().toISOString(), initialReplyNo: lastReplyNo,
            lastCheckedReplyNo: lastReplyNo, hasUpdate: false, newReplyCount: 0,
            firstNewReplyNo: null
        };
        const postId = postData.id;
        const wasSaved = savedPostIds.has(postId);
        await sendMessageWithRetry({ action: 'toggleSavePost', data: postData });
        if (wasSaved) {
            savedPostIds.delete(postId);
        } else {
            savedPostIds.add(postId);
        }
        setSaveButtonAppearance(saveButton, !wasSaved);
    });

    const postHead = postElement.querySelector('.post-head');
    if (!postHead) return;
    const replyLink = postHead.querySelector('.rlink');
    const postActionWrap = postHead.querySelector('.post-action-wrap');
    const delButton = Array.from(postHead.querySelectorAll('.-del-button')).find(el => !el.closest('noscript'));

    if (replyLink) {
        replyLink.after(saveButton);
    } else if (postActionWrap) {
        postActionWrap.after(saveButton);
    } else if (delButton) {
        delButton.before(saveButton);
    } else {
        postHead.appendChild(saveButton);
    }
}

function addHideButtonToThread(threadElement) {
    const threadNo = threadElement.dataset.no;
    const postHead = threadElement.querySelector('.post.threadpost .post-head');
    if (!threadNo || !postHead || postHead.querySelector('.komica-hider-btn')) return;

    const hideButton = document.createElement('span');
    const isHidden = threadElement.dataset.hiddenByThread === 'true';
    hideButton.textContent = isHidden ? '[已隱藏]' : '[隱藏此串]';
    hideButton.className = 'komica-hider-btn text-button';
    hideButton.style.marginLeft = '5px';
    hideButton.style.cursor = 'pointer';
    hideButton.title = '點擊以隱藏此討論串';

    hideButton.addEventListener('click', async () => {
        threadElement.dataset.hiddenByThread = 'true';
        updateElementVisibility(threadElement, true, '已手動隱藏此串');
        hideButton.textContent = '[已隱藏]';
        await sendMessageWithRetry({ action: 'hideThread', threadNo: threadNo });
    });

    const saveButton = postHead.querySelector('.komica-saver-btn');
    if (saveButton) {
        saveButton.after(hideButton);
    } else {
        const replyLink = postHead.querySelector('.rlink');
        const postActionWrap = postHead.querySelector('.post-action-wrap');
        if (replyLink) {
            replyLink.after(hideButton);
        } else if (postActionWrap) {
            postActionWrap.after(hideButton);
        } else {
            postHead.appendChild(hideButton);
        }
    }
}

function addNgIdButtonToPost(postElement) {
    const ngId = getPostId(postElement);
    if (!ngId) return;

    let ngButton = postElement.querySelector('.komica-ngid-btn');
    if (ngButton) {
        if (ngButton.dataset.ngid !== ngId) {
            ngButton.dataset.ngid = ngId;
            updateNgIdButtonState(ngButton, ngId);
        }
        return;
    }

    ngButton = document.createElement('span');
    ngButton.className = 'komica-ngid-btn text-button';
    ngButton.dataset.ngid = ngId;
    ngButton.style.marginLeft = '5px';
    ngButton.style.cursor = 'pointer';
    ngButton.style.fontWeight = 'bold';
    
    updateNgIdButtonState(ngButton, ngId);

    ngButton.addEventListener('click', async () => {
        const isCurrentlyNg = currentNgIds.includes(ngId);
        if (isCurrentlyNg) {
            unhidePostsByNgId(ngId);
            await sendMessageWithRetry({ action: 'removeNgId', ngId: ngId });
        } else {
            currentNgIds = [...new Set([...currentNgIds, ngId])];
            updateNgIdButtonsForId(ngId);
            applyNgIdFilterToAllPosts();
            await sendMessageWithRetry({ action: 'addNgId', ngId: ngId });
        }
    });

    const idElement = postElement.querySelector('.id[data-id]');
    const idMenuToggle = postElement.querySelector('.post-id-menu-toggle');
    const nowElement = postElement.querySelector('.post-head .now');

    if (idMenuToggle) {
        idMenuToggle.after(ngButton);
    } else if (idElement) {
        idElement.after(ngButton);
    } else if (nowElement) {
        nowElement.after(ngButton);
    } else {
        const postHead = postElement.querySelector('.post-head');
        if (postHead) postHead.appendChild(ngButton);
    }
}

// --- 搜圖按鈕 ---
function addImageSearchButton(postElement) {
    if (!imageSearchEnabled) return;
    if (postElement.querySelector('.komica-search-img-btn')) return;

    const fileTextLink = postElement.querySelector('.file-text a[href]');
    if (!fileTextLink) return;

    const imageUrl = fileTextLink.href;
    if (!imageUrl || !imageUrl.match(/\.(jpe?g|png|gif|webp)(\?|$)/i)) return;

    const searchBtn = document.createElement('span');
    searchBtn.className = 'komica-search-img-btn text-button';
    searchBtn.textContent = '[搜圖]';
    searchBtn.style.marginLeft = '6px';
    searchBtn.style.cursor = 'pointer';
    searchBtn.title = '點擊前往 SauceNAO 以圖搜圖';

    searchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const searchUrl = `https://saucenao.com/search.php?url=${encodeURIComponent(imageUrl)}`;
        window.open(searchUrl, '_blank');
    });

    fileTextLink.after(searchBtn);
}

// --- 輔助與狀態同步 ---
function unhideElement(selector, buttonText) {
    const element = document.querySelector(selector);
    if (element) {
        delete element.dataset.hiddenByThread;
        updateElementVisibility(element, false);
        const button = element.querySelector('.komica-hider-btn');
        if (button) button.textContent = buttonText;
    }
}

function updateSaveButtonAppearance(postNo, isSaved) {
    const postElement = document.querySelector(`.post[data-no="${postNo}"]`);
    if (postElement) {
        const saveButton = postElement.querySelector('.komica-saver-btn');
        if (saveButton) {
            setSaveButtonAppearance(saveButton, isSaved);
        }
    }
}

function updateSaveButtonState(button, postNo) {
    const isSaved = savedPostIds.has(`post-${postNo}`);
    setSaveButtonAppearance(button, isSaved);
}

function setSaveButtonAppearance(button, isSaved) {
    if (!button) return;
    button.textContent = isSaved ? '[已記憶]' : '[記憶此串]';
    button.style.color = isSaved ? '#28a745' : '';
    button.style.fontWeight = isSaved ? 'bold' : '';
}

function updateNgIdButtonState(button, ngId) {
    const isNg = currentNgIds.includes(ngId);
    button.textContent = isNg ? '[解除NG]' : '[NG]';
    button.style.color = isNg ? '#ffc107' : '#d9534f';
    button.title = isNg ? `點擊以將 ID:${ngId} 從 NG 列表中移除` : `點擊以將 ID:${ngId} 加入 NG 列表`;
}

function applyHiddenThreads(hiddenThreads) {
    const hiddenSet = new Set(hiddenThreads);
    document.querySelectorAll('.thread').forEach(threadElement => {
        const threadNo = threadElement.dataset.no;
        if (!threadNo) return;
        if (hiddenSet.has(threadNo)) {
            threadElement.dataset.hiddenByThread = 'true';
            updateElementVisibility(threadElement, true, '已手動隱藏此串');
            const button = threadElement.querySelector('.komica-hider-btn');
            if (button) button.textContent = '[已隱藏]';
        } else if (threadElement.dataset.hiddenByThread) {
            delete threadElement.dataset.hiddenByThread;
            updateElementVisibility(threadElement, false);
            const button = threadElement.querySelector('.komica-hider-btn');
            if (button) button.textContent = '[隱藏此串]';
        }
    });
}

function normalizeRecordIds(records) {
    return (records || []).map(item => item.id || item);
}

function updateNgIdButtonsForId(ngId) {
    document.querySelectorAll(`.komica-ngid-btn[data-ngid="${ngId}"]`).forEach(button => {
        updateNgIdButtonState(button, ngId);
    });
}

function processElements() {
    document.querySelectorAll('.post').forEach(post => {
        addSaveButtonToPost(post);
        addNgIdButtonToPost(post);
        addImageSearchButton(post);
    });
    document.querySelectorAll('.thread').forEach(addHideButtonToThread);
}

function setupObserver() {
    const callback = (mutationsList, observer) => {
        let shouldProcess = false;
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.matches && (node.matches('.post, .thread') || (node.querySelector && node.querySelector('.post, .thread')))) {
                            shouldProcess = true;
                            break;
                        }
                        if (node.matches && (node.matches('.id, .post-action-wrap, .post-id-menu-toggle') || (node.querySelector && node.querySelector('.id, .post-action-wrap, .post-id-menu-toggle')))) {
                            shouldProcess = true;
                            break;
                        }
                    }
                }
            }
            if (shouldProcess) break;
        }
        if (shouldProcess) {
            processElements();
            applyNgIdFilterToAllPosts();
            applyKeywordFilterToAllPosts();
        }
    };
    const observer = new MutationObserver(callback);
    observer.observe(document.body, { childList: true, subtree: true });
}

async function initialize() {
    if (!document.body) {
        await new Promise(resolve => {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', resolve, { once: true });
            } else {
                resolve();
            }
        });
    }
    await refreshSettings();
    await refreshSavedPostsCache();
    await applyNgIdFilter();
    await applyKeywordFilter();
    processElements();
    proactiveUpdateReset();
    hideStoredThreads();
    setupObserver();
    setupHotkeys();

    if (browser.storage && browser.storage.onChanged) {
        browser.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;
            if (changes.collapseMode || changes.enableImageSearch) {
                refreshSettings().then(() => {
                    processElements();
                    applyNgIdFilterToAllPosts();
                    applyKeywordFilterToAllPosts();
                });
            }
            if (changes.ngIds) {
                currentNgIds = normalizeRecordIds(changes.ngIds.newValue);
                applyNgIdFilterToAllPosts();
                document.querySelectorAll('.komica-ngid-btn').forEach(button => {
                    updateNgIdButtonState(button, button.dataset.ngid);
                });
            }
            if (changes.ngKeywords) {
                currentNgKeywords = (changes.ngKeywords.newValue || []).map(item => item.keyword || item);
                applyKeywordFilterToAllPosts();
            }
            if (changes.hiddenThreads) {
                const hiddenThreads = normalizeRecordIds(changes.hiddenThreads.newValue);
                applyHiddenThreads(hiddenThreads);
            }
        });
    }

    window.addEventListener('load', () => {
        processElements();
        applyNgIdFilter();
        applyKeywordFilter();
    });
    setTimeout(() => {
        processElements();
        applyNgIdFilter();
        applyKeywordFilter();
    }, 500);
}

initialize();
