const got = require('@/utils/got');
const cheerio = require('cheerio');
const { getCookie } = require('./util');

function fetchPageHtmlWithCookie(linkPath, cacheKey, cache, cookie) {
    const url = `https://mbasic.facebook.com${linkPath}`;
    return cache.tryGet(cacheKey, async () => {
        const { data: html } = await got.get(url, {
            headers: { Cookie: cookie },
        });
        return html;
    });
}

const fetchPageHtml = async (linkPath, cacheKey, cache, maxTries = 1) => {
    if (maxTries > 0) {
        const cookie = await getCookie(cache);
        const html = fetchPageHtmlWithCookie(linkPath, cacheKey, cache, cookie);
        const $ = cheerio.load(html);
        if ($('a[href*="login.php"]').length === 0) {
            return html;
        } else {
            cache.set('fb-cookie', '');
            return await fetchPageHtml(linkPath, cacheKey, cache, maxTries - 1);
        }
    } else {
        throw 'Login Fail';
    }
};

const parseStoryPage = async (linkPath, cache) => {
    const { searchParams: q } = new URL('https://mbasic.facebook.com' + linkPath);
    const storyFbId = q.get('story_fbid');
    const storyId = q.get('id');
    const cacheKey = `story/${storyFbId}/${storyId}`;

    const html = await fetchPageHtml(linkPath, cacheKey, cache);
    const $ = cheerio.load(html);

    const url = `https://www.facebook.com/story.php?story_fbid=${storyFbId}&id=${storyId}`;
    const $story = $('#m_story_permalink_view').eq(0);
    const $box = $story.find('div > div > div > div').eq(0);
    const $attach = $story.find('div > div > div > div:nth-child(3)').eq(0);

    const attachLinkList = $attach
        .find('a')
        .toArray()
        .map((a) => $(a).attr('href'));
    const isAttachAreImageSet = attachLinkList.filter((link) => new RegExp('/photos/|photo.php').test(link)).length === attachLinkList.length;

    $box.find('header').eq(0).remove();
    const title = $box.text();
    const postContent = $box.html();
    const reactionAndCommentsCollapsed = getReactionsAndComments($);
    const content = postContent + reactionAndCommentsCollapsed;

    let images = [];
    if (isAttachAreImageSet) {
        images = await Promise.all(attachLinkList.map((link) => parsePhotoPage(link, cache)));
    }

    return {
        url,
        title,
        content,
        images,
    };
};

function isNode(obj) {
    return obj !== null && typeof obj === 'object' && (obj.name || obj.type === 'root' || obj.type === 'text' || obj.type === 'comment');
}

/**
 *
 * @param {cheerio.Element} el
 */
function getTextAndImage(el) {
    if (!isNode(el)) {
        throw 'Expected a node';
    } else if (el.type === 'text') {
        return el.data;
    } else if (el.type === 'comment') {
        return '';
    } else if (el.type === 'tag') {
        if (el.tagName === 'img') {
            return cheerio.html(el);
        } else if (!Array.isArray(el.childNodes)) {
            return '';
        } else {
            return el.childNodes
                .map((c) => getTextAndImage(c))
                .filter((s) => s.trim().length > 0)
                .join('');
        }
    } else {
        throw 'Unexpected el.type: ' + el.type;
    }
}

function getReactionsAndComments($) {
    const $commentInput = $('[id^="composer-"]');
    $commentInput.remove();
    const $reactions = $('[id^="sentence_"]');
    const $comments = $('#add_comment_switcher_placeholder ~ * > div > *');
    $comments.find('a').each((i, a) => {
        $(a).removeAttr('href'); // disable all link
        a.tagName = 'strong';
    });
    const reaction = `<hr><div><strong>Reactions: </strong>${$reactions.text()}</div>`;
    const comments = `<div><strong>Comments: </strong>${$comments
        .toArray()
        .map((comment) =>
            $(comment)
                .children()
                .toArray()
                .map((el) => getTextAndImage(el))
                .filter((x) => x.trim() !== '')
                .join('<br>')
        )
        .filter((x) => x.trim() !== '')
        .join('<br><br>')}</div>`;
    return reaction + comments;
}

async function getRedirectImage(imgPath, cache) {
    const shouldRedirectImage = imgPath.startsWith('/');
    if (shouldRedirectImage) {
        const url = new URL(imgPath, 'https://mbasic.facebook.com/').href;
        const cookie = await getCookie(cache);

        const html = await cache.tryGet(imgPath, async () => {
            const { data: html } = await got.get(url, {
                headers: { Cookie: cookie },
            });
            return html;
        });
        const $ = cheerio.load(html);

        return $('a').attr('href').replace(/&amp;/g, '&');
    } else {
        return imgPath;
    }
}

const parsePhotoPage = async (linkPath, cache) => {
    const getPathname = (linkPath) => {
        if (/photo.php/.test(linkPath)) {
            const { searchParams: q } = new URL('https://mbasic.facebook.com' + linkPath);
            const fbId = q.get('fbid');
            const id = q.get('id');
            return `/${id}/photos/${fbId}`;
        } else {
            const { pathname } = new URL('https://mbasic.facebook.com' + linkPath);
            return pathname;
        }
    };
    const pathname = getPathname(linkPath);
    const cacheKey = `photos${pathname}`;

    const html = await fetchPageHtml(linkPath, cacheKey, cache);
    const $ = cheerio.load(html);

    const url = `https://www.facebook.com${pathname}`;
    const $content = $('#MPhotoContent div.msg > div');
    const postContent = $content.html();
    const reactionAndCommentsCollapsed = getReactionsAndComments($);
    const content = postContent + reactionAndCommentsCollapsed;

    const image = $('#MPhotoContent div.desc.attachment > span > div > span > a[target=_blank].sec').attr('href');

    return {
        title: $content.text(),
        url,
        content,
        image: await getRedirectImage(image, cache),
    };
};

module.exports = async (ctx) => {
    const { id } = ctx.params;
    const userId = encodeURIComponent(id);
    const linkPath = `/${userId}?v=timeline`;

    const html = await fetchPageHtml(linkPath, userId, ctx.cache, 2);
    const $ = cheerio.load(html);

    const itemLinks = $('footer > div:nth-child(2) a[href$="#footer_action_list"]')
        .toArray()
        .map((a) => $(a).attr('href'));

    const items = await Promise.all(
        itemLinks.map(async (itemLink) => {
            if (new RegExp(`^/.+/photos/`).test(itemLink)) {
                const data = await parsePhotoPage(itemLink, ctx.cache);
                return {
                    title: data.title,
                    link: data.url,
                    description: `<img src="${data.image}"><br>${data.content}`,
                };
            }
            if (new RegExp(`^/story.php`).test(itemLink)) {
                const data = await parseStoryPage(itemLink, ctx.cache);
                const isSingleImageStory = data.images.length === 1;
                const isEmptyImageList = data.images.length === 0;

                let desc = '';
                desc += data.images.map((image) => `<img src="${image.image}"><br>${image.content}`).join('<br>');
                if (!isSingleImageStory) {
                    !isEmptyImageList && (desc += '<br>');
                    desc += data.content;
                }

                return {
                    title: data.title,
                    link: data.url,
                    description: desc,
                };
            }
        })
    );

    const userTitle = $('#m-timeline-cover-section span strong').text();
    const pageTitle = $('#m-timeline-cover-section h1 span').text();

    ctx.state.data = {
        title: userTitle || pageTitle,
        link: `https://www.facebook.com/${userId}`,
        description: $('#m-timeline-cover-section > div > div:nth-child(2)').find('br').replaceWith('\n').text(),
        item: items.filter((item) => !!item),
    };
};
