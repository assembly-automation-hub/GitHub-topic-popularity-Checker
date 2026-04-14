document.getElementById('checkButton').addEventListener('click', async () => {
    const input = document.getElementById('topicInput').value;
    const token = document.getElementById('tokenInput').value.trim();
    const resultsDiv = document.getElementById('results');
    const button = document.getElementById('checkButton');
    
    const topics = input.split('\n')
                        .map(t => t.trim())
                        .filter(t => t.length > 0);

    if (topics.length === 0) return;

    resultsDiv.innerHTML = '';
    button.disabled = true;

    for (const topic of topics) {
        const item = document.createElement('div');
        item.className = 'result-item';
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'topic-name';
        nameSpan.textContent = topic;
        
        const countSpan = document.createElement('span');
        countSpan.textContent = 'Loading...';
        
        item.appendChild(nameSpan);
        item.appendChild(countSpan);
        resultsDiv.appendChild(item);

        try {
            const url = `https://api.github.com/search/repositories?q=topic:${encodeURIComponent(topic)}&per_page=1`;
            const headers = {
                'Accept': 'application/vnd.github.v3+json'
            };

            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const response = await fetch(url, { headers });

            if (!response.ok) {
                if (response.status === 403) {
                    throw new Error('API Rate Limit Exceeded');
                }
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            countSpan.textContent = `${data.total_count.toLocaleString()} public`;
        } catch (error) {
            countSpan.className = 'error';
            countSpan.textContent = error.message;
        }

        await new Promise(resolve => setTimeout(resolve, 2500));
    }

    button.disabled = false;
});
