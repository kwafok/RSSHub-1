const cheerio = require('cheerio');
const got = require('@/utils/got');
const config = require('@/config').value;
const assert = require('assert');

function fromEntries(keyValues = []) {
    const result = {};
    keyValues.forEach(([k, v]) => {
        result[k] = v;
    });
    return result;
}

const FB_COOKIE_CACHE_KEY = 'fb-cookie';

/**
 * async function 获取cookie
 * @desc 返回一个可用的cookie，使用 `got` 发起请求的时候，传入到`options.header.cookie`即可
 */
async function getCookie(cache) {
    assert(config.facebook, 'Facebook Config is required');

    const { username, password, cookie } = config.facebook;
    assert(cookie || (username && password), 'Facebook cookie or (username and password) are required');

    if (cookie) {
        return cookie;
    } else {
        const cookieByLogin = await tryGetCookieByLogin(username, password, cache);
        assert(cookieByLogin, 'Invalid Facebook email or password');
        console.log({ cookieByLogin });
        return cookieByLogin;
    }
}

const getCookieByLogin = async (username, password) => {
    const form_url = 'https://mbasic.facebook.com';
    const login_url = 'https://mbasic.facebook.com/login/device-based/regular/login/?refsrc=https%3A%2F%2Fmbasic.facebook.com%2F&lwv=100&refid=8';
    const form = await got.get(form_url);
    const getCookieStr = (headers) => headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    const csrf_token_cookie = getCookieStr(form.headers);
    const $ = cheerio.load(form.data);
    const inputs = $('form')
        .find('input[type="hidden"]')
        .toArray()
        .map((input) => [$(input).attr('name'), $(input).attr('value')])
        .filter(([name]) => name);

    const login = await got({
        method: 'post',
        url: login_url,
        headers: {
            referer: login_url,
            cookie: csrf_token_cookie,
        },
        form: {
            ...fromEntries(inputs),
            email: username,
            pass: password,
        },
        followRedirect: false,
    });

    if (login.statusCode !== 302) {
        return '';
    } else {
        return getCookieStr(login.headers);
    }
};

let cookie$ = null;
async function tryGetCookieByLogin(username, password, cache) {
    if (!cookie$) {
        cookie$ = cache
            .tryGet(
                FB_COOKIE_CACHE_KEY,
                () => getCookieByLogin(username, password),
                86400 * 3 * 1000 // Cookie有效期3天
            )
            .finally(() => {
                cookie$ = null;
            });
    }

    try {
        return await cookie$;
    } catch (e) {
        return '';
    }
}

module.exports = {
    getCookie,
};
