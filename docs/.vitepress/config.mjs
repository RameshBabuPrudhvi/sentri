import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Sentri',
  description: 'Autonomous QA Platform — AI-powered test generation, self-healing execution, and real-time observability.',
  base: '/sentri/docs/',

  // Localhost URLs in guide pages are intentional examples, not real links
  ignoreDeadLinks: [
    /^https?:\/\/localhost/,
  ],

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/sentri/docs/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Sentri Docs' }],
    ['meta', { property: 'og:description', content: 'AI-powered autonomous QA platform' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Sentri',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API Reference', link: '/api/' },
      { text: 'Code Docs', link: '/jsdoc/index.html', target: '_blank' },
      { text: 'Changelog', link: '/changelog' },
      {
        text: 'Links',
        items: [
          { text: 'GitHub', link: 'https://github.com/RameshBabuPrudhvi/sentri' },
          { text: 'App', link: 'https://rameshbabuprudhvi.github.io/sentri/' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is Sentri?', link: '/guide/what-is-sentri' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Architecture', link: '/guide/architecture' },
          ],
        },
        {
          text: 'Core Concepts',
          items: [
            { text: 'Crawling', link: '/guide/crawling' },
            { text: 'Test Generation', link: '/guide/test-generation' },
            { text: 'API Testing', link: '/guide/api-testing' },
            { text: 'Test Dials', link: '/guide/test-dials' },
            { text: 'Review Workflow', link: '/guide/review-workflow' },
            { text: 'Self-Healing', link: '/guide/self-healing' },
            { text: 'AI Providers', link: '/guide/ai-providers' },
            { text: 'CI/CD Triggers', link: '/guide/ci-cd-triggers' },
            { text: 'Command Palette', link: '/guide/command-palette' },
          ],
        },
        {
          text: 'Deployment',
          items: [
            { text: 'Docker', link: '/guide/docker' },
            { text: 'GitHub Pages + Render', link: '/guide/github-pages-render' },
            { text: 'Environment Variables', link: '/guide/env-vars' },
          ],
        },
        {
          text: 'Advanced',
          items: [
            { text: 'Authentication', link: '/guide/authentication' },
            { text: 'Rebranding', link: '/guide/rebranding' },
            { text: 'Production Checklist', link: '/guide/production' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Overview', link: '/api/' },
            { text: 'Projects', link: '/api/projects' },
            { text: 'Tests', link: '/api/tests' },
            { text: 'Runs', link: '/api/runs' },
            { text: 'Settings', link: '/api/settings' },
            { text: 'Authentication', link: '/api/auth' },
          ],
        },
        {
          text: 'Code Documentation',
          items: [
            { text: 'Overview', link: '/api/code-docs' },
            { text: 'JSDoc (auto-generated)', link: '/jsdoc/index.html', target: '_blank' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/RameshBabuPrudhvi/sentri' },
    ],

    editLink: {
      pattern: 'https://github.com/RameshBabuPrudhvi/sentri/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Sentri Contributors',
    },
  },
})
