/**
 * Content Script - Extracts saved post data from LinkedIn's DOM.
 *
 * Injected into linkedin.com/saved when the user scans. Parses list items to extract title, author,
 * description, hashtags, and links. Returns structured items for classification and storage. Runs in
 * page context and returns data directly when executed via chrome.scripting.executeScript.
 */

(function () {
    'use strict';

    // Stable ID from URL prevents duplicate items across scans
    function generateStableId(url, fallbackIndex) {
        if (!url) return `linkedin-fallback-${Date.now()}-${fallbackIndex}`;

        let identifier = null;

        // Try to extract activity ID
        const activityMatch = url.match(/activity[:\-](\d+)/);
        if (activityMatch) {
            identifier = `activity-${activityMatch[1]}`;
        }

        // Try to extract job ID
        if (!identifier) {
            const jobMatch = url.match(/\/jobs\/view\/(\d+)/);
            if (jobMatch) {
                identifier = `job-${jobMatch[1]}`;
            }
        }

        // Try to extract pulse/article slug
        if (!identifier) {
            const pulseMatch = url.match(/\/pulse\/([^/?]+)/);
            if (pulseMatch) {
                identifier = `pulse-${pulseMatch[1]}`;
            }
        }

        // Try to extract post slug
        if (!identifier) {
            const postMatch = url.match(/\/posts\/([^/?]+)/);
            if (postMatch) {
                identifier = `post-${postMatch[1]}`;
            }
        }

        // Fallback: hash the URL
        if (!identifier) {
            identifier = `url-${simpleHash(url)}`;
        }

        return `linkedin-${identifier}`;
    }

    // Simple hash function for URL fallback
    function simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    }

    // Check if text is metadata/junk we should skip
    function isMetadataText(text) {
        if (!text || text.length < 5) return true;

        if (/^\d+[hdwm]o?\s*$/.test(text.trim())) return true;
        if (/^\d+[hdwmo]+\s*•/.test(text.trim())) return true;
        if (/visible to everyone/i.test(text)) return true;
        if (/^reposted\s*(from|by)?/i.test(text.trim())) return true;
        if (/^(1st|2nd|3rd|\d+th)$/i.test(text.trim())) return true;
        if (/^[•·\.\s]+$/.test(text)) return true;
        if (/^follow(ing)?$/i.test(text.trim())) return true;
        if (/^\d+\s*(likes?|comments?|reposts?|reactions?)$/i.test(text.trim())) return true;

        return false;
    }

    // Clean and validate text
    function cleanText(text) {
        if (!text) return '';
        return text
            .replace(/\s+/g, ' ')
            .replace(/[\n\r]+/g, ' ')
            .replace(/\s*•\s*/g, ' - ')
            .trim();
    }

    // Extract structured data from a single saved post list item
    function extractSavedItemData(li, index) {
        // === FIND THE POST LINK (most important) ===
        const postLink = li.querySelector(
            'a[href*="/feed/update/"], ' +
            'a[href*="/posts/"], ' +
            'a[href*="/pulse/"], ' +
            'a[href*="/jobs/view/"]'
        );

        if (!postLink) {
            return null;
        }

        const postUrl = postLink.href;
        const id = generateStableId(postUrl, index);

        // === GET AUTHOR INFO + AUTHOR URL ===
        let author = '';
        let authorUrl = '';
        let authorHeadline = '';

        // Strategy 1: Look for profile link with name
        const profileLinks = li.querySelectorAll('a[href*="/in/"]');
        for (const link of profileLinks) {
            const text = link.innerText?.trim();
            if (text && text.length > 2 && !isMetadataText(text) && !/view\s*profile/i.test(text)) {
                author = cleanText(text.split('\n')[0]);
                // Capture the author's profile URL
                authorUrl = link.href.split('?')[0]; // Clean URL without tracking params
                break;
            }
        }

        // Strategy 2: Look for company page links if no personal profile found
        if (!author) {
            const companyLinks = li.querySelectorAll('a[href*="/company/"]');
            for (const link of companyLinks) {
                const text = link.innerText?.trim();
                if (text && text.length > 2 && !isMetadataText(text)) {
                    author = cleanText(text.split('\n')[0]);
                    authorUrl = link.href.split('?')[0];
                    break;
                }
            }
        }

        // Strategy 3: Look for author name in specific containers
        if (!author) {
            const authorContainers = li.querySelectorAll(
                '.update-components-actor__name, ' +
                '.feed-shared-actor__name, ' +
                '.entity-result__title-text, ' +
                '[data-control-name="actor"] span'
            );
            for (const container of authorContainers) {
                const text = container.innerText?.trim();
                if (text && !isMetadataText(text)) {
                    author = cleanText(text.split('\n')[0]);
                    // Try to find a link inside or near the container
                    const nearbyLink = container.closest('a') || container.querySelector('a');
                    if (nearbyLink && nearbyLink.href) {
                        authorUrl = nearbyLink.href.split('?')[0];
                    }
                    break;
                }
            }
        }

        // Strategy 4: Get headline/title if available
        const headlineEl = li.querySelector(
            '.update-components-actor__description, ' +
            '.feed-shared-actor__description, ' +
            '.entity-result__primary-subtitle'
        );
        if (headlineEl) {
            authorHeadline = cleanText(headlineEl.innerText);
        }

        // === GET POST CONTENT (Description) ===
        let description = '';

        // Strategy 1: Look for the main post text containers
        const textContainers = li.querySelectorAll(
            '.feed-shared-update-v2__description, ' +
            '.feed-shared-text, ' +
            '.update-components-text, ' +
            '.feed-shared-inline-show-more-text, ' +
            '.break-words'
        );

        for (const container of textContainers) {
            const text = container.innerText?.trim();
            if (text && text.length > 30 && !isMetadataText(text)) {
                description = text;
                break;
            }
        }

        // Strategy 2: Collect all meaningful paragraph text
        if (!description) {
            const paragraphs = Array.from(li.querySelectorAll('p, span.break-words'))
                .map(el => el.innerText?.trim())
                .filter(t => t && t.length > 30 && !isMetadataText(t));

            if (paragraphs.length > 0) {
                description = paragraphs.join('\n\n');
            }
        }

        // Clean and truncate description
        description = cleanText(description);
        if (description.length > 500) {
            description = description.substring(0, 497) + '...';
        }

        // === EXTRACT LINKS FROM POST CONTENT ===
        const contentLinks = [];
        const allLinks = li.querySelectorAll('a[href]');
        for (const link of allLinks) {
            const href = link.href;
            // Skip LinkedIn internal navigation links, only capture external or meaningful links
            if (href &&
                !href.includes('/in/') &&
                !href.includes('/feed/') &&
                !href.includes('/search/') &&
                !href.includes('linkedin.com/notifications') &&
                !href.includes('#') &&
                link.innerText?.trim().length > 3
            ) {
                contentLinks.push({
                    url: href,
                    text: cleanText(link.innerText).substring(0, 100),
                });
            }
        }

        // === EXTRACT HASHTAGS ===
        const hashtags = [];
        const hashtagEls = li.querySelectorAll('a[href*="/feed/hashtag/"]');
        for (const el of hashtagEls) {
            const tag = el.innerText?.trim().replace(/^#/, '');
            if (tag && tag.length > 1) {
                hashtags.push(tag.toLowerCase());
            }
        }

        // === CREATE A TITLE ===
        let title = '';

        if (description) {
            const sentences = description.split(/(?<=[.!?])\s+/);
            const firstSentence = sentences[0] || description;

            title = firstSentence.length > 100
                ? firstSentence.substring(0, 97) + '...'
                : firstSentence;
        }

        // Fallback titles based on URL type
        if (!title || title.length < 10) {
            if (postUrl.includes('/jobs/')) {
                title = author ? `Job post by ${author}` : 'Job opportunity';
            } else if (postUrl.includes('/pulse/')) {
                title = author ? `Article by ${author}` : 'LinkedIn article';
            } else {
                title = author ? `Post by ${author}` : 'LinkedIn post';
            }
        }

        if (!description && !title) {
            return null;
        }

        // Determine post type
        let postType = 'post';
        if (postUrl.includes('/jobs/')) postType = 'job';
        else if (postUrl.includes('/pulse/')) postType = 'article';
        else if (postUrl.includes('/posts/')) postType = 'post';

        return {
            id,
            title,
            description,
            url: postUrl,
            author,
            authorUrl,
            authorHeadline,
            postType,
            hashtags,
            contentLinks: contentLinks.slice(0, 5),
            savedDate: new Date().toISOString(),
            source: 'linkedin'
        };
    }

    // Main entry: scan DOM and return extracted items
    function scanSavedItems() {
        const items = [];
        const seenUrls = new Set();

        const main = document.querySelector('main.grid') || document.querySelector('main') || document.body;
        const listItems = main.querySelectorAll('li');
        console.log(`Knowledge Hub: Found ${listItems.length} list items`);

        listItems.forEach((li, index) => {
            const item = extractSavedItemData(li, index);
            if (item && item.url && !seenUrls.has(item.url)) {
                seenUrls.add(item.url);
                items.push(item);
            }
        });

        console.log(`Knowledge Hub: Extracted ${items.length} saved items`);
        return items;
    }

    return scanSavedItems();
})();
