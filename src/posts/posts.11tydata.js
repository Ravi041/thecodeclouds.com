export default {
  layout: 'post.njk',
  nav: 'blog',
  permalink: data => `/blog/${data.page.fileSlug}/`
};
