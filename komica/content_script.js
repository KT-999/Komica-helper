/**
 * Komica Post Saver - Content Script (v1.8.0)
 *
 * 變更：
 * 1. 補回手動重載功能的訊息監聽。
 * 2. 採用更穩定的帶重試訊息傳送機制。
 */

let currentNgIds = [];

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
        // **補入功能**
        case 'reapplyFunctions':
            console.log('收到手動重載指令，重新處理頁面元素...');
            processElements();
            applyNgIdFilter();
            break;
    }
    return true;
});

// --- 核心功能 ---
async function applyNgIdFilter() {
    const { success, data: ngIds } = await sendMessageWithRetry({ action: 'getNgIds' });
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
    const { success, data: hiddenThreads } = await sendMessageWithRetry({ action: 'getHiddenThreads' });
    if (!success || !hiddenThreads || hiddenThreads.length === 0) return;

    hiddenThreads.forEach(threadNo => {
        const threadElement = document.querySelector(`.thread[data-no="${threadNo}"]`);
        if (threadElement) {
            threadElement.style.display = 'none';
        }
    });
}

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

function processElements() {
    document.querySelectorAll('.post').forEach(post => {
        addSaveButtonToPost(post);
        addNgIdButtonToPost(post);
    });
    document.querySelectorAll('.thread').forEach(addHideButtonToThread);
}

function setupObserver() {
    const callback = (mutationsList, observer) => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.matches('.post')) {
                            addSaveButtonToPost(node);
                            addNgIdButtonToPost(node);
                        }
                        if (node.matches('.thread')) {
                            addHideButtonToThread(node);
                        }
                        node.querySelectorAll('.post').forEach(post => {
                            addSaveButtonToPost(post);
                            addNgIdButtonToPost(post);
                        });
                        node.querySelectorAll('.thread').forEach(addHideButtonToThread);
                    }
                });
            }
        }
    };
    const observer = new MutationObserver(callback);
    observer.observe(document.body, { childList: true, subtree: true });
}

async function initialize() {
    await applyNgIdFilter();
    processElements();
    proactiveUpdateReset();
    hideStoredThreads();
    setupObserver();
}

initialize();

