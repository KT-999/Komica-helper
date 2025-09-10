/**
 * Komica Post Saver - Content Script (v1.5.0 Stable)
 *
 * 變更：
 * 1. 新增 sendMessageWithRetry 函式，解決因背景腳本休眠導致的初始化失敗問題。
 * 2. 重構 initialize 函式，確保在獲取到必要資料後才執行頁面操作。
 * 3. 保留 MutationObserver 以處理頁面動態內容。
 */

// --- 全域變數 ---
let currentNgIds = [];

// --- 核心通訊函式 (新增) ---
async function sendMessageWithRetry(message, retries = 4, delay = 100) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await browser.runtime.sendMessage(message);
            // 檢查 response 是否為 undefined，有時擴充功能在重載時會發生
            if (typeof response !== 'undefined') {
                return response;
            }
        } catch (e) {
            if (i === retries - 1) { // 如果是最後一次重試
                console.error(`Komica Helper: 訊息傳送失敗 (重試 ${retries} 次後)。`, message, e);
                // 回傳一個失敗的物件結構，讓呼叫方可以處理
                return { success: false, error: e.message };
            }
            // 使用指數退讓策略等待，例如 100ms, 200ms, 400ms...
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        }
    }
}


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
            applyNgIdFilter(); // 由背景觸發的全局重濾
            break;
        case 'unhidePostsByNgId':
            unhidePostsByNgId(message.ngId);
            break;
        case 'reapplyFunctions': // 來自 popup 的手動重載指令
            console.log('Komica Helper: 收到重載指令，重新處理頁面元素...');
            initialize();
            break;
    }
    return true; // 保持通道開啟以進行非同步回應
});

// --- 核心功能 ---

// 根據 NGID 列表過濾頁面內容 (可選擇是否重新獲取列表)
async function applyNgIdFilter(skipFetch = false) {
    if (!skipFetch) {
        const response = await sendMessageWithRetry({ action: 'getNgIds' });
        if (!response.success) return;
        currentNgIds = response.data || [];
    }

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
                // 只有當這個元素是被這個 ID 隱藏時才將其顯示
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
    const response = await sendMessageWithRetry({ action: 'getAllPosts' });
    if (!response.success || !response.data || response.data.length === 0) return;

    document.querySelectorAll('.thread').forEach(threadElement => {
        const threadNo = threadElement.dataset.no;
        const savedPost = response.data.find(p => p.url.includes(`res=${threadNo}`));
        if (savedPost && savedPost.hasUpdate) {
            sendMessageWithRetry({ action: 'clearUpdateFlag', postId: savedPost.id });
        }
    });
}

// 在頁面載入時，隱藏所有已記錄的串
async function hideStoredThreads() {
    const response = await sendMessageWithRetry({ action: 'getHiddenThreads' });
    if (!response.success || !response.data || response.data.length === 0) return;

    response.data.forEach(threadNo => {
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
            lastCheckedReplyNo: lastReplyNo, hasUpdate: false, newReplyCount: 0,
            firstNewReplyNo: null
        };
        await sendMessageWithRetry({ action: 'toggleSavePost', data: postData });
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
        await sendMessageWithRetry({ action: 'hideThread', threadNo: threadNo });
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
            await sendMessageWithRetry({ action: 'removeNgId', ngId: ngId });
        } else {
            await sendMessageWithRetry({ action: 'addNgId', ngId: ngId });
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
    const result = await sendMessageWithRetry({ action: 'isPostSaved', postNo: postNo });
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

// 設定 MutationObserver 來監視 DOM 變化
function setupObserver() {
    const callback = (mutationsList, observer) => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.matches('.post, .thread') || node.querySelector('.post, .thread')) {
                            processElements(); // 重新處理所有元素
                            applyNgIdFilter(true); // 套用篩選，但不重新獲取列表
                        }
                    }
                });
            }
        }
    };
    const observer = new MutationObserver(callback);
    observer.observe(document.body, { childList: true, subtree: true });
}

// --- 初始執行 ---
async function initialize() {
    console.log("Komica Helper: Initializing...");
    // 優先且可靠地獲取 NGID 列表
    const response = await sendMessageWithRetry({ action: 'getNgIds' });

    if (response.success) {
        console.log("Komica Helper: Successfully connected to background script.");
        currentNgIds = response.data || [];

        // 獲取成功後，才執行所有頁面操作
        applyNgIdFilter(true); // 套用篩選 (跳過重新獲取)
        processElements();
        proactiveUpdateReset();
        hideStoredThreads();
        setupObserver();
    } else {
        console.error("Komica Helper: Could not initialize. Failed to fetch initial data from background script.");
    }
}

initialize();

