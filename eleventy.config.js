import { isPublished, validatePost, readingTime, plainText, json, topics } from './lib/content.js';

export default function(config) {
  config.addPassthroughCopy({ 'src/assets': 'assets', 'CNAME': 'CNAME' });
  config.addPassthroughCopy({ 'src/portfolio': 'portfolio' });
  config.ignores.add('src/portfolio/**');
  config.setNunjucksEnvironmentOptions({ autoescape: true });
  config.amendLibrary('md', markdown => {
    for (const type of ['fence', 'code_block']) {
      const render = markdown.renderer.rules[type];
      markdown.renderer.rules[type] = (...args) => render(...args).replace('<pre>', '<pre tabindex="0" aria-label="Code example">');
    }
    markdown.renderer.rules.table_open = () => '<table tabindex="0" aria-label="Reference table">\n';
  });
  config.addPreprocessor('publication', 'md', data => {
    if (data.layout === 'post.njk') validatePost(data);
    if (!isPublished(data)) return false;
  });
  config.addCollection('posts', api => api.getFilteredByGlob('src/posts/*.md')
    .filter(post => isPublished(post.data)).sort((a, b) => b.date - a.date));
  config.addFilter('dateLabel', value => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value)));
  config.addFilter('isoDate', value => new Date(value).toISOString());
  config.addFilter('readingTime', readingTime);
  config.addFilter('plainText', plainText);
  config.addFilter('json', json);
  config.addFilter('take', (items, count) => items.slice(0, count));
  config.addFilter('inTopic', (items, category) => items.filter(item => item.data.category === category));
  config.addFilter('topicSlug', name => topics.find(topic => topic.name === name)?.slug || '');
  config.addFilter('absolute', path => new URL(path, 'https://thecodeclouds.com').href);
  config.addGlobalData('topics', topics);
  config.addGlobalData('buildDate', () => new Date());
  return { dir: { input: 'src', output: '_site', includes: '_includes', data: '_data' },
    templateFormats: ['njk', 'md', 'html', '11ty.js'], markdownTemplateEngine: false, htmlTemplateEngine: 'njk' };
}
