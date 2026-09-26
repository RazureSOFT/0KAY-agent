# -*- coding: utf-8 -*-
"""自动访问 chat.deepseek.com，然后输出「嘻嘻嘻」。

用法:
    python deepseek_visit.py            # 访问首页并输出嘻嘻嘻
    python deepseek_visit.py -v         # 额外打印状态码/耗时等信息
    python deepseek_visit.py --ua "..." # 自定义 User-Agent
"""

import argparse
import ssl
import sys
import time
import urllib.error
import urllib.request

URL = "https://chat.deepseek.com"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.5 Safari/605.1.15"
)
MESSAGE = "嘻嘻嘻"


def visit(url: str = URL, timeout: int = 15, verbose: bool = False, ua: str = UA) -> str:
    """访问 url，返回状态描述。访问失败也会正常返回，不影响输出。"""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
        },
    )
    ctx = ssl.create_default_context()
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read(4096)
            status = f"HTTP {resp.status}, 收到 {len(body)} 字节"
    except urllib.error.HTTPError as e:          # 429/403 等，站点已响应
        status = f"HTTP {e.code} {e.reason}"
    except Exception as e:                        # 断网、超时、证书问题等
        status = f"请求失败: {type(e).__name__}: {e}"
    if verbose:
        print(f"[访问] {url} -> {status} ({time.time() - started:.2f}s)")
    return status


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="访问 chat.deepseek.com 并输出嘻嘻嘻")
    parser.add_argument("--url", default=URL, help=f"目标地址，默认 {URL}")
    parser.add_argument("--timeout", type=int, default=15, help="超时秒数，默认 15")
    parser.add_argument("-v", "--verbose", action="store_true", help="打印访问详情")
    parser.add_argument("--ua", default=UA, help="自定义 User-Agent")
    args = parser.parse_args(argv)

    if args.verbose:
        print(f"[UA] {args.ua}")
    visit(args.url, timeout=args.timeout, verbose=args.verbose, ua=args.ua)
    print(MESSAGE)
    return 0


if __name__ == "__main__":
    # 兼容 Windows 控制台的非 UTF-8 编码
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
