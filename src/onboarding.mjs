export const nameQuestion = '请问你的姓名是什么？我会在公司知识库的 Markdown 盘和文件盘中分别建立你的专属文件夹。';

export function onboarding(profile) {
  return profile
    ? { status: 'ready', nextAction: 'continue_work', question: null }
    : { status: 'awaiting_name', nextAction: 'ask_user_name', question: nameQuestion };
}

export function profileGuidance(profile) {
  if (profile) return `知识归档已启用，员工：${profile.name}。Claude Code 与 Codex 共用此员工资料。不要为已有员工资料的安装重复询问姓名。`;
  return `公司知识库尚未登记员工姓名。请在首次可回复的对话回合主动询问用户：“${nameQuestion}”不要等用户提出初始化请求。如果用户在本轮已明确提供本次安装使用的姓名，调用 company-knowledge 的 kb_setup 完成登记，不重复提问。否则等待用户回答后再调用 kb_setup；不要从系统用户名、目录名或历史示例推断姓名。登记完成前不采集、不上传。两个盘已由安装程序配置，无需用户填写路径。`;
}

export const archiveGuidance = '已适配的文件操作由 Hook 自动归档，无需为归档改变工具或写法。需要主动查询归档时可用 kb_read_work_file / kb_status；整理可复用经验时可用 kb_save_knowledge。只有 stored 表示已保存；pending、retry_pending、scope_paused 不能说成已上传。';
