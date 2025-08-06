/**
 * Komica Post Saver - Content Script (Complete & Final Version with inline NGID)
 *
 * 功能：
 * 1. 注入「記憶此串」、「隱藏此串」、「NGID」按鈕。
 * 2. 實現 NGID 過濾邏輯，在頁面載入和動態更新時隱藏指定 ID 的貼文或串。
 * 3. 監聽背景指令，以同步 UI 狀態 (按鈕外觀、解除隱藏、解除 NGID 過濾)。
 * 4. 在頁面載入時，主動檢查使用者是否正在閱讀已追蹤的串，並重設更新基準。
 * 5. 使用 MutationObserver 處理動態載入的內容。
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
    currentNgIds = ngIds || []; // 更新全域的 NGID 列表

    // 更新所有 NG 按鈕的狀態
    document.querySelectorAll('.komica-ngid-btn').forEach(btn => {
        updateNgIdButtonState(btn, btn.dataset.ngid);
    });

    // 執行過濾
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
                // 如果這個元素是因為這個 ID 被隱藏的，但現在 ID 不在 NG 列表裡了，就解除隱藏
                targetElement.style.display = '';
                delete targetElement.dataset.hiddenByNgid;
            }
        }
    });
}

// 解除由特定 NGID 隱藏的內容
function unhidePostsByNgId(ngId) {
    currentNgIds = currentNgIds.filter(id => id !== ngId); // 從全域列表中移除
    document.querySelectorAll(`[data-hidden-by-ngid="${ngId}"]`).forEach(element => {
        element.style.display = '';
        delete element.dataset.hiddenByNgid;
    });
    // 更新相關 NG 按鈕的狀態
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
    if (!idElement || idElement.querySelector('.komica-ngid-btn')) return;

    const ngId = idElement.dataset.id;
    const ngButton = document.createElement('span');
    ngButton.className = 'komica-ngid-btn text-button';
    ngButton.dataset.ngid = ngId;
    ngButton.style.marginLeft = '3px';
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

    idElement.appendChild(ngButton);
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
    if (result) {
        updateSaveButtonAppearance(postNo, result.isSaved);
    }
}

function updateNgIdButtonState(button, ngId) {
    const isNg = currentNgIds.includes(ngId);
    button.textContent = isNg ? '[解除NG]' : '[NG]';
    button.style.color = isNg ? '#ffc107' : '#d9534f';
    button.title = isNg ? `點擊以將 ID:${ngId} 從 NG 列表中移除` : `點擊以將 ID:${ngId} 加入 NG 列表`;
}

function processPageContent() {
    document.querySelectorAll('.post').forEach(post => {
        addSaveButtonToPost(post);
        addNgIdButtonToPost(post);
    });
    document.querySelectorAll('.thread').forEach(addHideButtonToThread);
    applyNgIdFilter();
}

// --- 初始執行與監聽 ---
const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
            processPageContent();
            break;
        }
    }
});

const mainForm = document.querySelector('form[name="delform"]');
if (mainForm) {
    observer.observe(mainForm, { childList: true, subtree: true });
}

// 首次載入頁面時，執行所有初始化函式
async function initialize() {
    await applyNgIdFilter(); // 先取得 NGID 列表，再處理頁面
    processPageContent();
    proactiveUpdateReset();
    hideStoredThreads();
}

initialize();
