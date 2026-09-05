const toggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
if (toggle && navigation) {
  toggle.hidden = false;
  toggle.closest('.masthead').classList.add('enhanced');
  const close = () => { toggle.setAttribute('aria-expanded', 'false'); navigation.classList.remove('is-open'); };
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    navigation.classList.toggle('is-open', open);
  });
  navigation.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); toggle.focus(); }
  });
  toggle.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
}

function expireOffers() {
  for (const card of document.querySelectorAll('[data-expires]')) {
    if (new Date(card.dataset.expires).getTime() <= Date.now()) card.hidden = true;
  }
  const empty = document.querySelector('#offers-empty');
  if (empty) empty.hidden = [...document.querySelectorAll('[data-expires]')].some(card => !card.hidden);
}
expireOffers();
setInterval(expireOffers, 60_000);

for (const button of document.querySelectorAll('[data-copy-code]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(button.dataset.copyCode); button.textContent = 'Copied'; }
    catch { button.textContent = 'Select and copy the code above'; }
  });
}

const searchForm = document.querySelector('#search-form');
if (searchForm) {
  searchForm.hidden = false;
  document.querySelector('#search-fallback').hidden = true;
  const input = document.querySelector('#search-input');
  const results = document.querySelector('#search-results');
  const status = document.querySelector('#search-status');
  let records;
  let requestSequence = 0;
  async function search(query) {
    const request = ++requestSequence;
    query = query.trim().slice(0, 160);
    const url = new URL(location.href);
    if (query) url.searchParams.set('q', query); else url.searchParams.delete('q');
    history.replaceState(null, '', url);
    results.replaceChildren();
    if (!query) { status.textContent = 'Search by a topic, a tool, or the problem you are working on.'; return; }
    status.textContent = 'Searching the notebook…';
    try {
      if (!records) {
        const response = await fetch('/search-index.json');
        if (!response.ok) throw new Error('Search index unavailable');
        records = await response.json();
      }
      if (request !== requestSequence) return;
      const terms = query.toLocaleLowerCase().split(/\s+/);
      const matches = records.filter(record => terms.every(term => `${record.title} ${record.description} ${record.category} ${record.text}`.toLocaleLowerCase().includes(term)));
      status.textContent = matches.length ? `${matches.length} ${matches.length === 1 ? 'article' : 'articles'} found for “${query}”.` : `No articles found for “${query}”. Try “Kubernetes”, “Terraform”, or “learning”.`;
      for (const record of matches) {
        const article = document.createElement('article');
        article.className = 'search-result';
        const category = document.createElement('span'); category.textContent = record.category;
        const heading = document.createElement('h2');
        const link = document.createElement('a'); link.href = record.url; link.textContent = record.title; heading.append(link);
        const description = document.createElement('p'); description.textContent = record.description;
        article.append(category, heading, description); results.append(article);
      }
    } catch {
      if (request === requestSequence) status.textContent = 'Search could not load. Please try again, or use the article archive below.';
    }
  }
  input.value = (new URLSearchParams(location.search).get('q') || '').slice(0, 160);
  searchForm.addEventListener('submit', event => { event.preventDefault(); void search(input.value); });
  if (input.value) void search(input.value);
}
