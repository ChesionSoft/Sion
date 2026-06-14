# AI Project Docs

AI Project Docs 是一个本地优先的开源项目设计文档工作台，面向小型外包项目和个人开发流程。

## 功能

- 创建本地项目
- 按 12 个固定流程节点设计项目
- 每个节点支持 Agent 对话、追问和 Markdown 编辑
- 汇总生成 `PROJECT_DESIGN.md`
- 导出正式 Word 文档 `项目开发设计文档.docx`
- 生成 AI 开发上下文包：`SPEC.md`、`TASKS.md`、`AGENTS.md`

## 本地启动

```bash
npm install
npm run dev
```

打开：

```text
http://localhost:3000
```

## 模型配置

第一版使用 OpenAI-compatible Chat Completions API。可以使用 OpenAI、DeepSeek、通义千问、硅基流动或其他兼容服务。

复制环境变量示例：

```bash
cp .env.example .env.local
```

然后填写：

```env
OPENAI_COMPATIBLE_API_BASE_URL=https://api.example.com/v1
OPENAI_COMPATIBLE_API_KEY=your-key
OPENAI_COMPATIBLE_MODEL=your-model
```

## 本地文件结构

```text
projects/
  <project-id>/
    project.json
    nodes/
    chat/
    exports/
```

## 设计流程节点

1. 项目基本信息
2. 需求背景与建设目标
3. 用户角色与权限
4. 业务流程设计
5. 功能模块设计
6. 页面与交互设计
7. 数据结构设计
8. 接口设计
9. 技术架构与部署
10. 开发任务拆分
11. 待确认事项与风险
12. 最终文档生成
