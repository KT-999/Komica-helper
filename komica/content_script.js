/**
 * Komica Post Saver - Content Script (Complete & Final Version with inline NGID)
 *
 * 功能：
 * 1. 注入「記憶此串」、「隱藏此串」、「NGID」按鈕。
 * 2. 實現 NGID 過濾邏輯。
 * 3. 監聽背景指令以同步 UI 狀態。
 * 4. 在頁面載入時，主動檢查並重設更新基準。
 * 5. 新增：使用「點擊事件監聽」作為 failsafe，確保能處理 [展開] 等動態內容。
 */

// --- 全域變數 ---
let currentNgIds = [];

// --- 訊息監聽 ---

browser.runtime.onMessage.addListener((message) => {
    switch (message.action) {
        case 'updateButtonUI':
            updateSaveButtonAppearance(message.postNo, message.isSaved);
            break;
        case 'unhideThread':
            unhideElement(`.thread[data-no="${message.threadNo}"]`, '[隱藏此串]');
            break;
        case 'applyNgIdFilter':
            applyNgIdFilter();
            break;
        case 'unhidePostsByNgId':
            unhidePostsByNgId(message.ngId);
            break;
    }
    return true;
});

// --- 核心功能 ---

// 根據 NGID 列表過濾頁面內容
async function applyNgIdFilter() {
    const { success, data: ngIds } = await browser.runtime.sendMessage({ action: 'getNgIds' });
    if (!success) return;
    currentNgIds = ngIds || [];

    document.querySelectorAll('.komica-ngid-btn').forEach(btn => {
        updateNgIdButtonState(btn, btn.dataset.ngid);
    });

    document.querySelectorAll('.post').forEach(postElement => {
        const idElement = postElement.querySelector('.id');
        if (idElement) {
            const currentId = idElement.dataset.id;
            const shouldHide = currentNgIds.includes(currentId);
            let targetElement = postElement.classList.contains('threadpost') ? postElement.closest('.thread') : postElement;
            if (!targetElement) targetElement = postElement;

            if (shouldHide) {
                targetElement.style.display = 'none';
                targetElement.dataset.hiddenByNgid = currentId;
            } else if (targetElement.dataset.hiddenByNgid === currentId) {
                targetElement.style.display = '';
                delete targetElement.dataset.hiddenByNgid;
            }
        }
    });
}

// 解除由特定 NGID 隱藏的內容
function unhidePostsByNgId(ngId) {
    currentNgIds = currentNgIds.filter(id => id !== ngId);
    document.querySelectorAll(`[data-hidden-by-ngid="${ngId}"]`).forEach(element => {
        element.style.display = '';
        delete element.dataset.hiddenByNgid;
    });
    document.querySelectorAll(`.komica-ngid-btn[data-ngid="${ngId}"]`).forEach(btn => {
        updateNgIdButtonState(btn, ngId);
    });
}

// 主動檢查並重設「記憶」功能的更新基準
async function proactiveUpdateReset() {
    const { success, data: savedPosts } = await browser.runtime.sendMessage({ action: 'getAllPosts' });
    if (!success || !savedPosts || savedPosts.length === 0) return;

    document.querySelectorAll('.thread').forEach(threadElement => {
        const threadNo = threadElement.dataset.no;
        const savedPost = savedPosts.find(p => p.url.includes(`res=${threadNo}`));
        if (savedPost && savedPost.hasUpdate) {
            browser.runtime.sendMessage({ action: 'clearUpdateFlag', postId: savedPost.id });
        }
    });
}

// 在頁面載入時，隱藏所有已記錄的串
async function hideStoredThreads() {
    const { success, data: hiddenThreads } = await browser.runtime.sendMessage({ action: 'getHiddenThreads' });
    if (!success || !hiddenThreads || hiddenThreads.length === 0) return;

    hiddenThreads.forEach(threadNo => {
        const threadElement = document.querySelector(`.thread[data-no="${threadNo}"]`);
        if (threadElement) {
            threadElement.style.display = 'none';
        }
    });
}

// 新增「記憶」按鈕
function addSaveButtonToPost(postElement) {
    const postNo = postElement.dataset.no;
    if (!postNo || postElement.querySelector('.komica-saver-btn')) return;

    const saveButton = document.createElement('span');
    saveButton.className = 'komica-saver-btn text-button';
    saveButton.style.marginLeft = '5px';
    saveButton.style.cursor = 'pointer';
    saveButton.title = '點擊以儲存或取消儲存此貼文';
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
        let previewText = quoteElement ? quoteElement.innerText.trim().substring(0, 150) : '沒有內文';
        previewText = previewText.replace(/>>\d+/g, '').trim();
        const replies = threadElement.querySelectorAll('.post.reply');
        const lastReply = replies.length > 0 ? replies[replies.length - 1] : null;
        const lastReplyNo = lastReply ? parseInt(lastReply.dataset.no, 10) : parseInt(threadNo, 10);
        const postData = {
            id: `post-${postNo}`, postNo, url: dedicatedThreadUrl, title, preview: previewText,
            timestamp: new Date().toISOString(), initialReplyNo: lastReplyNo,
            lastCheckedReplyNo: lastReplyNo, hasUpdate: false, newReplyCount: 0
        };
        await browser.runtime.sendMessage({ action: 'toggleSavePost', data: postData });
        await updateSaveButtonState(saveButton, postNo);
    });

    const postHead = postElement.querySelector('.post-head');
    if (postHead) {
        const replyLink = postHead.querySelector('.rlink');
        if (replyLink) {
            replyLink.after(saveButton);
        } else {
            const delButton = postHead.querySelector('.-del-button');
            if (delButton) delButton.before(saveButton);
            else postHead.appendChild(saveButton);
        }
    }
}

// 新增「隱藏」按鈕 (只加在主樓)
function addHideButtonToThread(threadElement) {
    const threadNo = threadElement.dataset.no;
    const postHead = threadElement.querySelector('.post.threadpost .post-head');
    if (!threadNo || !postHead || postHead.querySelector('.komica-hider-btn')) return;

    const hideButton = document.createElement('span');
    hideButton.textContent = '[隱藏此串]';
    hideButton.className = 'komica-hider-btn text-button';
    hideButton.style.marginLeft = '5px';
    hideButton.style.cursor = 'pointer';
    hideButton.title = '點擊以隱藏此討論串';

    hideButton.addEventListener('click', async () => {
        threadElement.style.display = 'none';
        hideButton.textContent = '[已隱藏]';
        await browser.runtime.sendMessage({ action: 'hideThread', threadNo: threadNo });
    });

    const saveButton = postHead.querySelector('.komica-saver-btn');
    if (saveButton) {
        saveButton.after(hideButton);
    }
}

// 新增「NGID」按鈕
function addNgIdButtonToPost(postElement) {
    const idElement = postElement.querySelector('.id[data-id]');
    if (!idElement || (idElement.nextElementSibling && idElement.nextElementSibling.classList.contains('komica-ngid-btn'))) return;

    const ngId = idElement.dataset.id;
    const ngButton = document.createElement('span');
    ngButton.className = 'komica-ngid-btn text-button';
    ngButton.dataset.ngid = ngId;
    ngButton.style.marginLeft = '5px';
    ngButton.style.cursor = 'pointer';
    ngButton.style.fontWeight = 'bold';
    
    updateNgIdButtonState(ngButton, ngId);

    ngButton.addEventListener('click', async () => {
        const isCurrentlyNg = currentNgIds.includes(ngId);
        if (isCurrentlyNg) {
            await browser.runtime.sendMessage({ action: 'removeNgId', ngId: ngId });
        } else {
            await browser.runtime.sendMessage({ action: 'addNgId', ngId: ngId });
        }
    });

    idElement.after(ngButton);
}

// --- 輔助與初始化 ---

function unhideElement(selector, buttonText) {
    const element = document.querySelector(selector);
    if (element) {
        element.style.display = '';
        const button = element.querySelector('.komica-hider-btn');
        if (button) button.textContent = buttonText;
    }
}

function updateSaveButtonAppearance(postNo, isSaved) {
    const postElement = document.querySelector(`.post[data-no="${postNo}"]`);
    if (postElement) {
        const saveButton = postElement.querySelector('.komica-saver-btn');
        if (saveButton) {
            saveButton.textContent = isSaved ? '[已記憶]' : '[記憶此串]';
            saveButton.style.color = isSaved ? '#28a745' : '';
            saveButton.style.fontWeight = isSaved ? 'bold' : '';
        }
    }
}

async function updateSaveButtonState(button, postNo) {
    const result = await browser.runtime.sendMessage({ action: 'isPostSaved', postNo: postNo });
    if (result && result.success) {
        updateSaveButtonAppearance(postNo, result.isSaved);
    }
}

function updateNgIdButtonState(button, ngId) {
    const isNg = currentNgIds.includes(ngId);
    button.textContent = isNg ? '[解除NG]' : '[NG]';
    button.style.color = isNg ? '#ffc107' : '#d9534f';
    button.title = isNg ? `點擊以將 ID:${ngId} 從 NG 列表中移除` : `點擊以將 ID:${ngId} 加入 NG 列表`;
}

// 一個統一的函式，用來處理頁面上所有需要附加功能的元素
function processElements() {
    document.querySelectorAll('.post').forEach(post => {
        addSaveButtonToPost(post);
        addNgIdButtonToPost(post);
    });
    document.querySelectorAll('.thread').forEach(addHideButtonToThread);
}

// --- 初始執行與監聽 ---

// **新增：設定點擊事件監聽器作為 failsafe**
function setupClickListeners() {
    // 使用事件委派，將監聽器綁定在一個穩定的父元素上
    document.body.addEventListener('click', (event) => {
        // 檢查被點擊的元素是否是 [展開] 按鈕
        if (event.target.matches('.-expand-thread')) {
            console.log('[Komica Saver] 偵測到 [展開] 按鈕點擊，將在 750ms 後強制重新處理頁面。');
            // 等待一小段時間，讓網站的 AJAX 有時間完成並插入新內容
            setTimeout(() => {
                console.log('[Komica Saver] 執行點擊後的延遲處理...');
                processElements();
                applyNgIdFilter();
            }, 750); // 延遲 750 毫秒以確保內容已載入
        }
    });
    console.log('[Komica Saver] [展開] 按鈕的點擊監聽器已設定。');
}

// 首次載入頁面時，執行所有初始化函式
async function initialize() {
    console.log('[Komica Saver] 腳本初始化開始...');
    await applyNgIdFilter();
    console.log('[Komica Saver] 步驟 1/5: NGID 過濾已應用。');
    processElements();
    console.log('[Komica Saver] 步驟 2/5: 靜態內容已處理。');
    proactiveUpdateReset();
    console.log('[Komica Saver] 步驟 3/5: 已記憶串的更新狀態已檢查。');
    hideStoredThreads();
    console.log('[Komica Saver] 步驟 4/5: 已隱藏串已處理。');
    setupClickListeners();
    console.log('[Komica Saver] 步驟 5/5: 點擊監聽器已設定。初始化完成。');
}

initialize();
