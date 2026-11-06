# 研协 Notebook 内核启动脚本（IPython startup，内核启动时自动执行）。
#
# tqdm.auto / tqdm.autonotebook 在 Jupyter 内核里会用 ipywidgets 画进度条，
# 而 widget 走 comm 消息，研协前端不渲染，进度条看起来一直卡在 0%。
# 这里统一换成文本进度条（输出到 stderr，用 \r 刷新，前端按终端语义显示）。
# tqdm.asyncio 版本同时支持 `async for`；拿不到时退回 tqdm.std。
try:
    import warnings as _srh_warnings

    with _srh_warnings.catch_warnings():
        _srh_warnings.simplefilter("ignore")
        import tqdm.std
        import tqdm.auto
        import tqdm.autonotebook

        try:
            from tqdm.asyncio import tqdm as _srh_tqdm, trange as _srh_trange
        except Exception:
            _srh_tqdm, _srh_trange = tqdm.std.tqdm, tqdm.std.trange
        tqdm.auto.tqdm = tqdm.autonotebook.tqdm = _srh_tqdm
        tqdm.auto.trange = tqdm.autonotebook.trange = _srh_trange
    # 启动脚本在用户命名空间里执行：别留下多余的名字（变量查看器、自动补全里会看到）
    del _srh_tqdm, _srh_trange, _srh_warnings, tqdm
except Exception:
    pass
