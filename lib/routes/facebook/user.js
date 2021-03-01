const got = require('@/utils/got');
const cheerio = require('cheerio');
const { getCookie } = require('./util');

const fetchPageHtml = async (linkPath, cacheKey, cache) => {
    const url = `https://mbasic.facebook.com${linkPath}`;
    const cookie = await getCookie(cache);

    return cache.tryGet(cacheKey, async () => {
        const { data: html } = await got.get(url, {
            headers: { Cookie: cookie },
        });
        return html;
    });
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
    const content = $box.html();

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
    const content = $content.html();
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

    const html = await fetchPageHtml(linkPath, userId, ctx.cache);
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
