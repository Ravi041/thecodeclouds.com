import { plainText } from '../lib/content.js';
export default class {
  data() { return { permalink: '/search-index.json', eleventyExcludeFromCollections: true }; }
  render({ collections }) {
    return JSON.stringify(collections.posts.map(post => ({
      title: post.data.title, description: post.data.description, category: post.data.category,
      url: post.url, text: plainText(post.templateContent)
    })));
  }
}
