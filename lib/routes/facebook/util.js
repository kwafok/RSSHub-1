const cheerio = require('cheerio');
const got = require('@/utils/got');
const config = require('@/config').value;

function fromEntries(keyValues = []) {
    const result = {};
    keyValues.forEach(([k, v]) => {
        result[k] = v;
    });
    return result;
}

/**
 * async function 获取cookie
 * @desc 返回一个可用的cookie，使用 `got` 发起请求的时候，传入到`options.header.cookie`即可
 */

async function getCookie(cache) {
    if (!config.facebook || !config.facebook.username || !config.facebook.password) {
        throw 'Facebook Email and password are required';
    }
    const cookie = await getCookieByLogin(config.facebook.username, config.facebook.password, cache);
    if (!cookie) {
        throw 'Invalid Facebook email or password';
    }
    return cookie;
}

async function getCookieByLogin(username, password, cache) {
    const form_url = 'https://mbasic.facebook.com';
    const login_url = 'https://mbasic.facebook.com/login/device-based/regular/login/?refsrc=https%3A%2F%2Fmbasic.facebook.com%2F&lwv=100&refid=8';
    const cache_key = 'fb-cookie';

    const cached_cookie = await cache.get(cache_key);
    if (cached_cookie) {
        const { cookie, time } = JSON.parse(cached_cookie);
        const now = new Date().getTime();
        if (cookie && now - time < 86400 * 3 * 1000) {
            // 不考虑缓存过期的话，有效期最多允许3天
            return cookie;
        }
    }

    const { data, headers } = await got.get(form_url);
    const getCookieStr = (headers) => headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    const csrf_token_cookie = getCookieStr(headers);
    const $ = cheerio.load(data);
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
        cache.set(
            cache_key,
            JSON.stringify({
                cookie: '',
                time: new Date().getTime(),
            })
        );
        return '';
    } else {
        const user_token_cookie = getCookieStr(login.headers);

        cache.set(
            cache_key,
            JSON.stringify({
                cookie: user_token_cookie,
                time: new Date().getTime(),
            })
        );

        return user_token_cookie;
    }
}

module.exports = {
    getCookie,
};
