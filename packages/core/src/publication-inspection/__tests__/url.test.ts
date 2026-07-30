import { describe, expect, it } from 'vitest'
import samples from '../__fixtures__/url-samples.json'
import type { PublicationPlatform } from '../types'
import { parsePublicationUrl } from '../url'

describe('parsePublicationUrl', () => {
  for (const sample of samples) {
    it(sample.name, () => {
      const parsed = parsePublicationUrl(
        sample.platform as PublicationPlatform,
        sample.href,
      )

      expect(parsed).toMatchObject({
        platform: sample.platform,
        ...sample.expected,
      })
    })
  }

  it('rejects a valid-looking identity hosted on the wrong domain', () => {
    expect(
      parsePublicationUrl(
        'zhihu',
        'https://attacker.example/p/2000000000000000001',
      ),
    ).toBeNull()
  })

  it('rejects non-http protocols and URL userinfo', () => {
    expect(parsePublicationUrl('zhihu', 'javascript:alert(1)')).toBeNull()
    expect(
      parsePublicationUrl(
        'zhihu',
        'https://user:password@zhuanlan.zhihu.com/p/2000000000000000001',
      ),
    ).toBeNull()
  })

  it('rejects a valid-looking Sohu identity hosted on the wrong domain', () => {
    expect(
      parsePublicationUrl(
        'sohu',
        'https://attacker.example/a/1000000001_120000001',
      ),
    ).toBeNull()
  })

  it('does not infer Sohu identities from ambiguous or malformed locators', () => {
    expect(
      parsePublicationUrl(
        'sohu',
        'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?id=1&id=2',
      ),
    ).toEqual({ platform: 'sohu', surface: 'UNKNOWN' })
    expect(
      parsePublicationUrl('sohu', 'https://www.sohu.com/a/abc_120000001'),
    ).toEqual({ platform: 'sohu', surface: 'UNKNOWN' })
  })

  it('rejects a valid-looking Weixin identity hosted on the wrong domain', () => {
    expect(
      parsePublicationUrl(
        'weixin',
        'https://attacker.example/cgi-bin/appmsg?action=edit&appmsgid=900000001',
      ),
    ).toBeNull()
  })

  it('does not infer Weixin identities from ambiguous or malformed locators', () => {
    expect(
      parsePublicationUrl(
        'weixin',
        'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=1&appmsgid=2',
      ),
    ).toEqual({ platform: 'weixin', surface: 'UNKNOWN' })
    expect(
      parsePublicationUrl(
        'weixin',
        'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&action=view&appmsgid=1',
      ),
    ).toEqual({ platform: 'weixin', surface: 'UNKNOWN' })
    expect(
      parsePublicationUrl(
        'weixin',
        'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&t=not-an-editor&appmsgid=1',
      ),
    ).toEqual({ platform: 'weixin', surface: 'UNKNOWN' })
    expect(
      parsePublicationUrl(
        'weixin',
        'https://mp.weixin.qq.com/cgi-bin/appmsg?action=view&t=media%2Fappmsg_edit&appmsgid=1',
      ),
    ).toEqual({ platform: 'weixin', surface: 'UNKNOWN' })
    expect(
      parsePublicationUrl(
        'weixin',
        'http://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&appmsgid=1',
      ),
    ).toEqual({ platform: 'weixin', surface: 'UNKNOWN' })
    expect(
      parsePublicationUrl(
        'weixin',
        'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=1&idx=1&idx=2',
      ),
    ).toEqual({ platform: 'weixin', surface: 'UNKNOWN' })
    expect(
      parsePublicationUrl(
        'weixin',
        'https://mp.weixin.qq.com/s?__biz=MzA0000000000%3D%3D&mid=1&idx=1&sn=not-a-signature',
      ),
    ).toEqual({ platform: 'weixin', surface: 'UNKNOWN' })
  })

  it('rejects ambiguous or untrusted Toutiao identities', () => {
    expect(
      parsePublicationUrl(
        'toutiao',
        'https://attacker.example/article/7667071065847677450/',
      ),
    ).toBeNull()
    expect(
      parsePublicationUrl(
        'toutiao',
        'https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=1&pgc_id=2',
      ),
    ).toEqual({ platform: 'toutiao', surface: 'UNKNOWN' })
    expect(
      parsePublicationUrl(
        'toutiao',
        'https://www.toutiao.com/article/7667071065847677450/?from=item',
      ),
    ).toEqual({ platform: 'toutiao', surface: 'UNKNOWN' })
  })

  it('does not guess unknown Zhihu URL shapes', () => {
    expect(
      parsePublicationUrl('zhihu', 'https://www.zhihu.com/question/123'),
    ).toEqual({ platform: 'zhihu', surface: 'UNKNOWN' })
  })
})
