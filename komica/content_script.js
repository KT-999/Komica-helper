/**
 * Komica Post Saver - Content Script (Cleaned Version)
 *
 * 功能：
 * 1. 在頁面上所有貼文旁注入「記憶此串」按鈕。
 * 2. 點擊按鈕時，收集貼文資訊 (包含最後回應編號) 並發送給背景。
 * 3. 監聽來自背景的指令，以同步按鈕的 UI 狀態。
 * 4. 在頁面載入時，主動檢查使用者是否正在閱讀已追蹤的串，並通知背景重設更新基準。
 * 5. 使用 MutationObserver 處理動態載入的內容 (如展開回應)。
 */

// --- 訊息監聽 ---

browser.runtime.onMessage.addListener((message) => {
    if (message.action === 'updateButtonUI') {
        const { postNo, isSaved } = message;
        const postElement = document.querySelector(`.post[data-no="${postNo}"]`);
        if (postElement) {
            const saveButton = postElement.querySelector('.komica-saver-btn');
            if (saveButton) {
                setButtonAppearance(saveButton, isSaved);
            }
        }
    }
    return true;
});

// --- 核心功能 ---

// 主動檢查並重設更新基準
async function proactiveUpdateReset() {
    const { success, data: savedPosts } = await browser.runtime.sendMessage({ action: 'getAllPosts' });
    if (!success || !savedPosts || savedPosts.length === 0) return;

    const threadsOnPage = document.querySelectorAll('.thread');
    threadsOnPage.forEach(threadElement => {
        const threadNo = threadElement.dataset.no;
        const savedPost = savedPosts.find(p => p.url.includes(`res=${threadNo}`));

        if (savedPost && savedPost.hasUpdate) {
            console.log(`[Komica Saver] 偵測到使用者正在閱讀已更新的串 No.${threadNo}，將重設更新狀態。`);
            browser.runtime.sendMessage({ action: 'clearUpdateFlag', postId: savedPost.id });
        }
    });
}

// 新增「記憶」按鈕到指定的貼文元素
function addSaveButtonToPost(postElement) {
    const postNo = postElement.dataset.no;
    if (!postNo || postElement.querySelector('.komica-saver-btn')) return;

    const saveButton = document.createElement('span');
    saveButton.className = 'komica-saver-btn text-button';
    saveButton.style.marginLeft = '5px';
    saveButton.style.cursor = 'pointer';
    saveButton.title = '點擊以儲存或取消儲存此貼文';

    updateButtonState(saveButton, postNo);

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
            id: `post-${postNo}`,
            postNo: postNo,
            url: dedicatedThreadUrl,
            title: title,
            preview: previewText,
            timestamp: new Date().toISOString(),
            initialReplyNo: lastReplyNo,
            lastCheckedReplyNo: lastReplyNo,
            hasUpdate: false,
            newReplyCount: 0
        };

        await browser.runtime.sendMessage({ action: 'toggleSavePost', data: postData });
        await updateButtonState(saveButton, postNo);
    });

    const postHead = postElement.querySelector('.post-head');
    if (postHead) {
        const replyLink = postHead.querySelector('.rlink');
        if (replyLink) {
            replyLink.after(saveButton);
        } else {
            const delButton = postHead.querySelector('.-del-button');
            if (delButton) {
                postHead.insertBefore(saveButton, delButton);
            } else {
                postHead.appendChild(saveButton);
            }
        }
    }
}

// --- 輔助與初始化 ---

// 根據儲存狀態設定按鈕外觀
function setButtonAppearance(button, isSaved) {
    if (isSaved) {
        button.textContent = '[已記憶]';
        button.style.color = '#28a745';
        button.style.fontWeight = 'bold';
    } else {
        button.textContent = '[記憶此串]';
        button.style.color = '';
        button.style.fontWeight = '';
    }
}

// 向背景查詢狀態並更新按鈕
async function updateButtonState(button, postNo) {
    const result = await browser.runtime.sendMessage({ action: 'isPostSaved', postNo: postNo });
    if (result) {
        setButtonAppearance(button, result.isSaved);
    }
}

// 處理頁面上所有已存在的貼文
function processAllPosts() {
    document.querySelectorAll('.post').forEach(addSaveButtonToPost);
}

// **修正：將 MutationObserver 還原為標準、穩定的寫法**
const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (mutation.addedNodes.length) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) { // 檢查是否為元素節點
                    // 如果新增的節點本身就是一個 post
                    if (node.matches('.post')) {
                        addSaveButtonToPost(node);
                    }
                    // 或者新增的節點 *包含* post (例如展開回應時)
                    node.querySelectorAll('.post').forEach(addSaveButtonToPost);
                }
            }
        }
    }
});

const mainForm = document.querySelector('form[name="delform"]');
if (mainForm) {
    observer.observe(mainForm, { childList: true, subtree: true });
}

// --- 初始執行 ---
processAllPosts();
proactiveUpdateReset();
