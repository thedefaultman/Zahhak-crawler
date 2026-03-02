// ===== Browsing Capture — Content Script =====
// Injected into every page. Uses Defuddle for universal content extraction,
// then Turndown for HTML→Markdown conversion. No site-specific selectors.

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__browsingCaptureInjected) return;
  window.__browsingCaptureInjected = true;

  // Track which URLs we've already sent to the service worker (for this page lifetime)
  const capturedInSession = new Set();

  // ===== Configuration =====
  const SKIP_URL_PATTERNS = [
    // Browser internal pages
    /^chrome/,
    /^chrome-extension/,
    /^about:/,
    /^file:/,
    /^data:/,
    /^blob:/,
    /^moz-extension/,
    /^edge:/,
    // Auth & security
    /\/login/i,
    /\/signin/i,
    /\/sign-in/i,
    /\/signup/i,
    /\/sign-up/i,
    /\/auth/i,
    /\/oauth/i,
    /\/sso/i,
    /\/password/i,
    /\/forgot-password/i,
    /\/reset-password/i,
    /\/account\/security/i,
    /\/workspace-signin/i,
    // Financial
    /\/checkout/i,
    /\/payment/i,
    /\/banking/i,
    /\/billing/i,
    // App dashboards & internal UI (not content pages)
    /drive\.google\.com/i,
    /mail\.google\.com/i,
    /calendar\.google\.com/i,
    /\/admin\//i,
    /\/dashboard\/?$/i,
    /\/settings\/?$/i,
    /\/preferences\/?$/i,
    /\/notifications\/?$/i,
    /\/inbox\/?$/i,
    // OAuth & consent flows
    /\/oauth_redirect/i,
    /\/auth_callback/i,
    /\/consent/i,
    /accounts\.google\.com/i,
    /\.mcp\.claude\.com/i,
    // API key / credential management pages
    /\/api-keys/i,
    /\/api_keys/i,
    /\/tokens\/?$/i,
    /\/secrets\/?$/i,
    /\/credentials\/?$/i,
    /\/access-tokens/i,
    /\/personal-access-tokens/i,
    /\/settings\/.*keys/i,
    /\/settings\/.*tokens/i,
  ];

  // Pages where content is mostly app UI noise, not useful knowledge
  const LOW_VALUE_CONTENT_PATTERNS = [
    /cookie\s*(consent|manager|preferences|policy|notice)/i,
    /^sign\s*in\s*(to|with)/i,
    /^log\s*in\s*(to|with)/i,
    /^connect\s+.*\s+to\s+/i,
    /^find\s+your\s+workspace/i,
    /^manage\s+consent/i,
  ];

  const MIN_CONTENT_LENGTH = 200;
  const CAPTURE_DELAY_MS = 2500;

  // ===== Check if we should capture this page =====
  function shouldSkipUrl(url) {
    return SKIP_URL_PATTERNS.some(pattern => pattern.test(url));
  }

  // ===== Main Extraction Pipeline =====
  async function extractPageContent() {
    const url = window.location.href;

    if (shouldSkipUrl(url)) return null;

    let state;
    try {
      state = await chrome.storage.local.get(['isActive']);
      if (!state.isActive) return null;
    } catch (e) {
      return null;
    }

    try {
      // Step 1: Use Defuddle to extract main content (universal, no site-specific code)
      const defuddle = new Defuddle(document, { url });
      const result = defuddle.parse();

      if (!result || !result.content || result.content.length < MIN_CONTENT_LENGTH) {
        return null;
      }

      // Step 2: Extract what Defuddle gives us (title, author, description, etc.)
      const title = result.title || document.title || 'Untitled';
      const author = result.author || '';
      const description = result.description || '';
      const published = result.published || '';
      const domain = result.domain || new URL(url).hostname.replace(/^www\./, '');
      const siteName = result.site || '';

      // Step 2b: Check if this is a low-value page based on title content
      const titleAndDesc = (title + ' ' + description).trim();
      if (LOW_VALUE_CONTENT_PATTERNS.some(p => p.test(titleAndDesc))) {
        return null;
      }

      // Step 3: Convert Defuddle's clean HTML to Markdown using Turndown
      let markdown = htmlToMarkdown(result.content);

      if (!markdown || markdown.trim().length < 100) return null;

      // Step 4: Clean up the markdown
      markdown = cleanMarkdown(markdown);

      // Step 5: Detect content type from content itself (not from domain)
      const contentType = detectContentType(url, result, markdown);

      // Step 6: Build structured data
      const wordCount = result.wordCount || markdown.split(/\s+/).filter(w => w.length > 0).length;

      return {
        url,
        title,
        domain,
        timestamp: new Date().toISOString(),
        contentType,
        markdownContent: markdown,
        metadata: {
          author,
          datePublished: published,
          description,
          siteName,
          keywords: extractKeywords(),
          language: document.documentElement.lang || 'en',
          wordCount,
          schemaType: getSchemaType(result.schemaOrgData),
        },
        images: extractImages(),
        links: extractLinks(),
      };
    } catch (err) {
      console.error('[BrowsingCapture] Extraction error:', err);
      return null;
    }
  }

  // ===== Schema.org type extraction =====
  function getSchemaType(schemaData) {
    if (!schemaData) return '';
    // schemaOrgData can be an object or array
    const items = Array.isArray(schemaData) ? schemaData : [schemaData];
    for (const item of items) {
      if (item && item['@type']) {
        const t = Array.isArray(item['@type']) ? item['@type'][0] : item['@type'];
        return t;
      }
    }
    return '';
  }

  // ===== Keywords from meta tags =====
  function extractKeywords() {
    const metaKeywords = document.querySelector('meta[name="keywords"]');
    if (metaKeywords) {
      return metaKeywords.getAttribute('content')
        .split(',')
        .map(k => k.trim().toLowerCase())
        .filter(k => k.length > 0);
    }
    return [];
  }

  // ===== Content Type Detection (universal, content-based) =====
  function detectContentType(url, defuddleResult, markdown) {
    const urlLower = url.toLowerCase();

    // 1. Schema.org type (most reliable when available)
    const schemaType = getSchemaType(defuddleResult.schemaOrgData);
    if (schemaType) {
      const schemaLower = schemaType.toLowerCase();
      if (/article|newsarticle|blogposting|report/.test(schemaLower)) return 'article';
      if (/techarticle|apireference/.test(schemaLower)) return 'documentation';
      if (/howto|recipe/.test(schemaLower)) return 'tutorial';
      if (/qapage|question|answer|discussionforumposting/.test(schemaLower)) return 'forum';
      if (/softwaresourcecode|coderepository/.test(schemaLower)) return 'code';
      if (/scholarlyarticle|medicalscholarlyarticle/.test(schemaLower)) return 'article';
    }

    // 2. URL structure hints (generic patterns, not domain-specific)
    if (/\/wiki\//i.test(urlLower)) return 'wiki';
    if (/\/docs?\//i.test(urlLower) || /\/documentation\//i.test(urlLower) || /\/reference\//i.test(urlLower) || /\/api\//i.test(urlLower)) return 'documentation';
    if (/\/tutorial/i.test(urlLower) || /\/how-to/i.test(urlLower) || /\/guide\//i.test(urlLower)) return 'tutorial';
    if (/\/questions?\//i.test(urlLower) || /\/issues?\//i.test(urlLower) || /\/discussions?\//i.test(urlLower) || /\/pull\//i.test(urlLower) || /\/threads?\//i.test(urlLower)) return 'forum';
    if (/\/blog\//i.test(urlLower) || /\/posts?\//i.test(urlLower) || /\/articles?\//i.test(urlLower)) return 'article';

    // 3. Content structure heuristics
    const codeBlockCount = (markdown.match(/```/g) || []).length / 2;
    const headingCount = (markdown.match(/^#{1,3}\s/gm) || []).length;
    const listItemCount = (markdown.match(/^[\s]*[-*]\s/gm) || []).length;
    const hasNumberedSteps = /^#{2,3}\s*(step\s+\d|phase\s+\d|\d+[\.\)]\s)/im.test(markdown);
    const hasQAStructure = /^#{2,3}\s*(q:|question|answer|a:)/im.test(markdown) ||
                           (markdown.match(/\?\n/g) || []).length >= 3;

    if (codeBlockCount >= 3) return 'documentation';
    if (hasNumberedSteps) return 'tutorial';
    if (hasQAStructure) return 'forum';
    if (codeBlockCount >= 1 && headingCount <= 3) return 'code';

    // 4. Metadata hints
    if (defuddleResult.author || defuddleResult.published) return 'article';

    // 5. Heuristic: lots of headings + lists = wiki/documentation
    if (headingCount >= 5 && listItemCount >= 5) return 'wiki';

    return 'general';
  }

  // ===== HTML to Markdown Conversion =====
  function htmlToMarkdown(html) {
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
    });

    // Custom rule: preserve code blocks better
    turndownService.addRule('fencedCodeBlock', {
      filter: function (node) {
        return node.nodeName === 'PRE' && node.querySelector('code');
      },
      replacement: function (content, node) {
        const code = node.querySelector('code');
        const className = code.getAttribute('class') || '';
        // Also check data-lang attribute (Defuddle standardizes code blocks this way)
        const dataLang = code.getAttribute('data-lang') || '';
        const langMatch = className.match(/language-(\w+)/);
        const lang = langMatch ? langMatch[1] : dataLang;
        return `\n\`\`\`${lang}\n${code.textContent}\n\`\`\`\n`;
      },
    });

    // Custom rule: handle tables
    turndownService.addRule('table', {
      filter: 'table',
      replacement: function (content, node) {
        const rows = node.querySelectorAll('tr');
        if (rows.length === 0) return content;

        let markdown = '\n';
        rows.forEach((row, i) => {
          const cells = row.querySelectorAll('th, td');
          const cellTexts = Array.from(cells).map(c =>
            c.textContent.trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')
          );
          markdown += '| ' + cellTexts.join(' | ') + ' |\n';
          if (i === 0) {
            markdown += '| ' + cellTexts.map(() => '---').join(' | ') + ' |\n';
          }
        });
        return markdown + '\n';
      },
    });

    // Convert emoji images (base64 data URIs with emoji alt text) to plain emoji
    turndownService.addRule('emojiImages', {
      filter: function (node) {
        if (node.nodeName !== 'IMG') return false;
        const alt = node.getAttribute('alt') || '';
        const src = node.getAttribute('src') || '';
        const isEmoji = /^[\p{Emoji}\u200d\ufe0f]{1,8}$/u.test(alt);
        const isDataUri = src.startsWith('data:');
        const isTinyImage = (node.width <= 32 || node.height <= 32 || !node.width);
        return isEmoji || (isDataUri && isTinyImage) || (alt.length <= 2 && alt.length > 0);
      },
      replacement: function (content, node) {
        const alt = node.getAttribute('alt') || '';
        if (/^[\p{Emoji}\u200d\ufe0f]{1,8}$/u.test(alt)) {
          return alt + ' ';
        }
        return '';
      },
    });

    // Remove images with no alt text (usually decorative)
    turndownService.addRule('removeDecorativeImages', {
      filter: function (node) {
        return node.nodeName === 'IMG' && !node.getAttribute('alt');
      },
      replacement: function () { return ''; },
    });

    // Remove data URI images (base64 blobs that add noise)
    turndownService.addRule('removeDataUriImages', {
      filter: function (node) {
        if (node.nodeName !== 'IMG') return false;
        const src = node.getAttribute('src') || '';
        return src.startsWith('data:') && !(/^[\p{Emoji}]/u.test(node.getAttribute('alt') || ''));
      },
      replacement: function () { return ''; },
    });

    // Remove avatar-style images (small profile pictures linked to profiles)
    turndownService.addRule('removeAvatarImages', {
      filter: function (node) {
        if (node.nodeName !== 'IMG') return false;
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || '';
        // Detect avatar URLs (common patterns across all sites)
        const isAvatar = /avatar|profile|user.*photo|gravatar/i.test(src) ||
                         /avatar|profile/i.test(node.className || '');
        const isSmall = (node.width > 0 && node.width <= 64) || (node.height > 0 && node.height <= 64);
        // Username-style alt text: @username or very short
        const isUserAlt = /^@/.test(alt) || (alt.length <= 20 && isSmall);
        return isAvatar || (isSmall && isUserAlt);
      },
      replacement: function () { return ''; },
    });

    try {
      return turndownService.turndown(html);
    } catch (e) {
      console.error('[BrowsingCapture] Turndown error:', e);
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      return tmp.textContent || tmp.innerText;
    }
  }

  // ===== Markdown Cleanup =====
  function cleanMarkdown(md) {
    // Remove leftover base64 data URI image references
    md = md.replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, '');

    // Remove avatar image links: [![@username](avatar-url)](profile-url) — universal pattern
    md = md.replace(/\[!\[[^\]]*\]\([^)]*(?:avatar|gravatar|profile)[^)]*\)\]\([^)]*\)\s*/gi, '');

    // Remove lines that are just empty links
    md = md.replace(/^\[?\s*\]\([^)]+\)\s*$/gm, '');

    // Remove common boilerplate/navigation text (full lines only)
    const boilerplatePatterns = [
      /^\[?skip to (?:content|main|navigation)\]?(?:\(#[^)]*\))?\s*$/gim,
      /^add (?:icon|cover|comment|verification)\s*$/gim,
      /^(?:share|bookmark|like|subscribe|follow)\s*$/gim,
      /^(?:table of contents|on this page|in this article)\s*$/gim,
      /^(?:cookie|privacy) (?:consent|manager|preferences|notice|policy)\s*$/gim,
      /^(?:accept|reject|manage) (?:all )?cookies?\s*$/gim,
      /^(?:sign (?:in|up)|log (?:in|out)|register)\s*$/gim,
      /^\[(?:sign (?:in|up)|log (?:in|out))\]\([^)]*\)\s*$/gim,
      /^(?:functional|advertising|analytics|performance) cookies?\s*$/gim,
    ];
    for (const pattern of boilerplatePatterns) {
      md = md.replace(pattern, '');
    }

    // Remove excessive blank lines (3+ → 2)
    md = md.replace(/\n{3,}/g, '\n\n');

    // Trim leading/trailing whitespace
    md = md.trim();

    return md;
  }

  // ===== Image Extraction =====
  function extractImages() {
    const images = [];
    document.querySelectorAll('img[alt]').forEach(img => {
      const alt = img.getAttribute('alt') || '';
      const src = img.getAttribute('src') || '';
      if (src.startsWith('data:')) return;
      if (/^[\p{Emoji}\u200d\ufe0f]{1,8}$/u.test(alt)) return;
      if (/avatar|gravatar|profile/i.test(src)) return;
      if (alt.trim().length > 5) {
        images.push({
          src: img.src,
          alt: alt.trim(),
          caption: img.closest('figure')?.querySelector('figcaption')?.textContent?.trim() || '',
        });
      }
    });
    return images.slice(0, 20);
  }

  // ===== Link Extraction =====
  function extractLinks() {
    const links = [];
    const seen = new Set();
    const currentDomain = window.location.hostname;

    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      const text = a.textContent.trim();
      if (!href || !text || text.length < 3 || seen.has(href)) return;

      try {
        const linkUrl = new URL(href);
        if (linkUrl.protocol !== 'http:' && linkUrl.protocol !== 'https:') return;
        seen.add(href);
        links.push({
          href,
          text: text.substring(0, 100),
          isInternal: linkUrl.hostname === currentDomain,
        });
      } catch (e) { /* invalid URL */ }
    });

    return links.slice(0, 50);
  }

  // ===== Trigger Capture =====
  function triggerCapture() {
    setTimeout(async () => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(async () => { await runCapture(); }, { timeout: 5000 });
      } else {
        await runCapture();
      }
    }, CAPTURE_DELAY_MS);
  }

  async function runCapture() {
    const pageData = await extractPageContent();
    if (!pageData) return;

    // Don't re-send the same URL from this page lifetime
    const urlKey = pageData.url.split('#')[0];
    if (capturedInSession.has(urlKey)) return;
    capturedInSession.add(urlKey);

    try {
      chrome.runtime.sendMessage({ type: 'PAGE_CAPTURED', data: pageData });
    } catch (e) {
      console.error('[BrowsingCapture] Failed to send to background:', e);
    }

    // Discover same-domain links for crawl mode
    discoverLinksForCrawl();
  }

  // ===== Crawl Mode: Link Discovery =====
  // Finds all same-domain links on the current page and reports them to the service worker.
  // The service worker decides whether crawl mode is active and whether to follow them.
  function discoverLinksForCrawl() {
    const currentHost = window.location.hostname.replace(/^www\./, '');
    const links = new Set();

    document.querySelectorAll('a[href]').forEach(a => {
      try {
        const href = a.href;
        if (!href) return;

        const linkUrl = new URL(href);

        // Only http/https
        if (linkUrl.protocol !== 'http:' && linkUrl.protocol !== 'https:') return;

        // Same domain check (compare base domains)
        const linkHost = linkUrl.hostname.replace(/^www\./, '');
        if (!isSameDomain(currentHost, linkHost)) return;

        // Skip anchors, query-only differences, and skip patterns
        linkUrl.hash = '';
        const cleanUrl = linkUrl.toString();

        // Skip URLs that match our skip patterns
        if (shouldSkipUrl(cleanUrl)) return;

        // Skip obviously non-content URLs
        if (/\.(png|jpg|jpeg|gif|svg|webp|ico|pdf|zip|tar|gz|mp4|mp3|woff2?|ttf|eot|css|js)$/i.test(linkUrl.pathname)) return;

        links.add(cleanUrl);
      } catch (e) { /* invalid URL */ }
    });

    if (links.size > 0) {
      try {
        chrome.runtime.sendMessage({
          type: 'CRAWL_LINKS_DISCOVERED',
          links: Array.from(links),
          fromUrl: window.location.href,
        });
      } catch (e) { /* service worker may not be listening */ }
    }
  }

  // Compare two hostnames to check if they belong to the same base domain
  function isSameDomain(host1, host2) {
    if (host1 === host2) return true;
    // Extract base domains (e.g., docs.github.com → github.com)
    const base1 = getBaseDomain(host1);
    const base2 = getBaseDomain(host2);
    return base1 === base2;
  }

  function getBaseDomain(host) {
    const MULTI_PART_TLDS = ['co.uk', 'co.jp', 'co.kr', 'co.in', 'co.nz', 'co.za',
      'com.au', 'com.br', 'com.cn', 'com.mx', 'com.sg', 'com.tw',
      'org.uk', 'net.au', 'ac.uk', 'gov.uk', 'edu.au'];
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_TLDS.includes(lastTwo)) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  }

  // ===== Brave Search Result Extraction (for Dataset Builder browser fallback) =====
  function extractBraveSearchResults() {
    const url = window.location.href;
    if (!url.includes('search.brave.com')) return;

    const results = [];

    // Primary selectors for Brave search results
    const selectors = [
      '#results .snippet[data-type="web"] .snippet-title a',
      '#results .snippet .title a',
      '#results a.result-header',
      '.web-results .snippet-title a',
      '#results .heading-serpresult a',
    ];

    let links = [];
    for (const sel of selectors) {
      links = document.querySelectorAll(sel);
      if (links.length > 0) break;
    }

    // Fallback: look for any result-like links inside #results
    if (links.length === 0) {
      const container = document.querySelector('#results') || document.querySelector('.search-results');
      if (container) {
        links = container.querySelectorAll('a[href^="http"]');
      }
    }

    const seen = new Set();
    links.forEach(a => {
      try {
        const href = a.href;
        if (!href || seen.has(href)) return;
        // Skip Brave internal links
        if (href.includes('brave.com') || href.includes('search.brave.com')) return;
        // Skip non-http
        const linkUrl = new URL(href);
        if (linkUrl.protocol !== 'http:' && linkUrl.protocol !== 'https:') return;

        seen.add(href);

        // Get title: link text or closest heading
        let title = a.textContent.trim();
        if (!title) {
          const heading = a.closest('.snippet')?.querySelector('h2, h3, .title');
          title = heading?.textContent?.trim() || '';
        }

        // Get snippet: sibling or parent description
        let snippet = '';
        const snippetContainer = a.closest('.snippet') || a.closest('.result');
        if (snippetContainer) {
          const descEl = snippetContainer.querySelector('.snippet-description, .snippet-content, .description, p');
          snippet = descEl?.textContent?.trim() || '';
        }

        if (title) {
          results.push({ url: href, title, snippet });
        }
      } catch (e) { /* invalid URL */ }
    });

    if (results.length > 0) {
      try {
        chrome.runtime.sendMessage({
          type: 'DATASET_SEARCH_RESULTS',
          results,
          query: new URL(url).searchParams.get('q') || '',
        });
      } catch (e) {
        console.error('[BrowsingCapture] Failed to send search results:', e);
      }
    }
  }

  // Auto-detect Brave search pages and extract results
  if (window.location.hostname.includes('search.brave.com')) {
    // Run immediately
    setTimeout(extractBraveSearchResults, 1500);
    // Also run after a delay for AJAX-loaded results
    setTimeout(extractBraveSearchResults, 3500);
  }

  // ===== SPA Navigation Detection =====
  let lastUrl = window.location.href;

  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      triggerCapture();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  const origPushState = history.pushState;
  history.pushState = function (...args) {
    origPushState.apply(this, args);
    if (window.location.href !== lastUrl) { lastUrl = window.location.href; triggerCapture(); }
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    if (window.location.href !== lastUrl) { lastUrl = window.location.href; triggerCapture(); }
  };

  window.addEventListener('popstate', () => {
    if (window.location.href !== lastUrl) { lastUrl = window.location.href; triggerCapture(); }
  });

  // ===== Listen for retry requests (e.g. when user toggles capture ON) =====
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'RETRY_CAPTURE') {
      triggerCapture();
    }
  });

  // ===== Initial Capture =====
  triggerCapture();
})();
