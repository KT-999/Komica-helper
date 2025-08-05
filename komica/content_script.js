/**
 * Komica Post Saver - Content Script
 * * 功能：
 * 1. 遍歷頁面上所有的貼文（.post）。
 * 2. 在每個貼文的標頭（.post-head）中插入一個「記憶此串」按鈕。
 * 3. 點擊按鈕時，收集貼文資訊並發送給 background.js 進行儲存。
 * 4. 使用 MutationObserver 來監聽動態載入的內容。
 * 5. **優化：監聽來自 background 的明確指令，直接更新 UI。**
 */

// **優化：監聽來自 background script 的 UI 更新指令**
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'updateButtonUI') {
        const { postNo, isSaved } = message;
        const postElement = document.querySelector(`.post[data-no="${postNo}"]`);
        if (postElement) {
            const saveButton = postElement.querySelector('.komica-saver-btn');
            if (saveButton) {
                console.log(`[Komica Saver] 收到 UI 更新通知 No.${postNo}, isSaved: ${isSaved}`);
                // 直接根據指令更新按鈕外觀，不再查詢
                setButtonAppearance(saveButton, isSaved);
            }
        }
    }
    return true; // 保持訊息通道開啟
});

// **新增：一個專門用來更新按鈕外觀的同步函式**
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

// 檢查儲存狀態並更新按鈕樣式（用於頁面載入和動態新增元素）
async function updateButtonState(button, postNo) {
    const result = await browser.runtime.sendMessage({ action: 'isPostSaved', postNo: postNo });
    if (result) {
        setButtonAppearance(button, result.isSaved);
    }
}

// 為指定的貼文元素添加「記憶」按鈕
function addSaveButtonToPost(postElement) {
    const postNo = postElement.dataset.no;
    if (!postNo) return; 

    if (postElement.querySelector('.komica-saver-btn')) {
        updateButtonState(postElement.querySelector('.komica-saver-btn'), postNo);
        return;
    }

    const saveButton = document.createElement('span');
    saveButton.className = 'komica-saver-btn text-button';
    saveButton.style.marginLeft = '5px';
    saveButton.style.cursor = 'pointer';
    saveButton.title = '點擊以儲存或取消儲存此貼文';

    updateButtonState(saveButton, postNo);

    saveButton.addEventListener('click', async () => {
        const threadElement = postElement.closest('.thread');
        if (!threadElement) {
            console.error("Komica Saver: Could not find parent thread for post:", postNo);
            return; 
        }
        const threadNo = threadElement.dataset.no;
        const pathParts = window.location.pathname.split('/');
        const boardPath = pathParts.length > 1 ? `/${pathParts[1]}/` : '/';
        const dedicatedThreadUrl = `${window.location.origin}${boardPath}pixmicat.php?res=${threadNo}`;
        
        const quoteElement = postElement.querySelector('.quote');
        const titleElement = postElement.querySelector('.post-head .title');
        const title = titleElement && titleElement.innerText.trim() !== '無題' ? titleElement.innerText.trim() : `No.${postNo}`;
        
        let previewText = quoteElement ? quoteElement.innerText.trim().substring(0, 150) : '沒有內文';
        previewText = previewText.replace(/>>\d+/g, '').trim();

        const postData = {
            id: `post-${postNo}`,
            postNo: postNo,
            url: dedicatedThreadUrl,
            title: title,
            preview: previewText,
            timestamp: new Date().toISOString()
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

// 處理頁面上所有已存在的貼文
function processAllPosts() {
    const allPosts = document.querySelectorAll('.post');
    allPosts.forEach(addSaveButtonToPost);
}

// 初始執行
processAllPosts();

// Komica 使用動態載入（例如展開串），需要監聽 DOM 變化
const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (mutation.addedNodes.length) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) {
                    if (node.matches('.post')) {
                        addSaveButtonToPost(node);
                    }
                    const newPosts = node.querySelectorAll('.post');
                    if (newPosts.length > 0) {
                        newPosts.forEach(addSaveButtonToPost);
                    }
                }
            }
        }
    }
});

// 監聽整個 form 的變化，這是 Komica 頁面的主要容器
const mainForm = document.querySelector('form[name="delform"]');
if (mainForm) {
    observer.observe(mainForm, { childList: true, subtree: true });
}
