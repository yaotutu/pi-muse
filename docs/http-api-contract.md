# HTTP/SSE 接入入口

本页只导航，不维护端点、字段、事件列表或历史兼容表。具体协议从当前源码 `src/http/contracts/` 自动生成；运行实例的版本必须与待接入代码匹配。

## 查看当前协议

- `/docs`：Scalar 渲染的可读接入说明。
- `/openapi.json`：自动生成的 OpenAPI，包括每个流自己的 SSE schema 与行为描述。
- `/api/health`：核对运行身份；源码模式和构建模式的 commit/sourceHash 不可混用，脏工作区不能只比较 commit。

使用实例的 base URL 加上这些路径；不能从本页或历史截图断言某个端口上的服务正在运行。

## 理解边界

- 聊天 AG-UI SSE 是执行流；断开和取消语义按聊天端点说明。
- `/api/events` 是独立通知流；通知失效后回读领域权威状态，不把断开通知流当成停止模型。
- Agent 是配置与数据归属，Session 是当前私聊上下文；群和来源讨论各自独立，不共享整个展示时间线。
- 写入不默认幂等，结果未明按具体端点核对；模型文件审批和手动文件确认不能互相绕过。

## 开发入口

- [API 开发规范](api-development.md)：契约、生成文档与多端验证要求。
- [Agent / Session 状态归属](frontend-agent-session-migration.md)：客户端恢复边界，不是字段规范。
- [架构规范](architecture.md)：执行、历史、业务存储与权限。
- [测试规范](testing.md)：协议、真实模型与页面验证的区别。

修改协议时同时更新源码、契约描述、回归与实际调用方；不要把关键规则只写在此 Markdown 中。
