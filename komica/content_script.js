/**
 * Komica Post Saver - Content Script
 * * 功能：
 * 1. 遍歷頁面上所有的貼文（.post）。
 * 2. 在每個貼文的標頭（.post-head）中插入一個「記憶此串」按鈕。
 * 3. 點擊按鈕時，收集貼文資訊（編號、預覽文字），並產生該串專屬的網址。
 * 4. 將資訊發送給 background.js 進行儲存。
 * 5. 使用 MutationObserver 來監聽動態載入的內容（如展開的回應），並為新內容加上按鈕。
 */

// 檢查儲存狀態並更新按鈕樣式
async function updateButtonState(button, postNo) {
    const result = await browser.runtime.sendMessage({ action: 'isPostSaved', postNo: postNo });
    if (result && result.isSaved) {
        button.textContent = '[已記憶]';
        button.style.color = '#28a745'; // Green color for saved state
        button.style.fontWeight = 'bold';
    } else {
        button.textContent = '[記憶此串]';
        button.style.color = ''; // Reset to default color
        button.style.fontWeight = '';
    }
}

// 為指定的貼文元素添加「記憶」按鈕
function addSaveButtonToPost(postElement) {
    const postNo = postElement.dataset.no;
    if (!postNo) return; // 如果找不到貼文編號，就跳過

    // 檢查是否已經有按鈕，防止重複添加
    if (postElement.querySelector('.komica-saver-btn')) {
        updateButtonState(postElement.querySelector('.komica-saver-btn'), postNo);
        return;
    }

    // 創建按鈕
    const saveButton = document.createElement('span');
    saveButton.className = 'komica-saver-btn text-button';
    saveButton.style.marginLeft = '5px';
    saveButton.style.cursor = 'pointer';
    saveButton.title = '點擊以儲存或取消儲存此貼文';

    updateButtonState(saveButton, postNo);

    // 按鈕點擊事件
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
        
        console.log(`[Komica Saver] 準備儲存的網址: ${dedicatedThreadUrl}`);

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

    // 將按鈕插入到 post-head 中
    const postHead = postElement.querySelector('.post-head');
    if (postHead) {
        const replyLink = postHead.querySelector('.rlink');
        if (replyLink) {
            // **修正：如果找到 [回應] 連結，就插在它後面**
            replyLink.after(saveButton);
        } else {
            // 如果沒有 [回應] 連結 (例如在回應中)，就插在 [del] 按鈕前面
            const delButton = postHead.querySelector('.-del-button');
            if (delButton) {
                postHead.insertBefore(saveButton, delButton);
            } else {
                // 如果連 del 都沒有，就直接加到最後
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
