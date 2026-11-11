const { HELP_COMMANDS, resolveCommandName } = require("./helpContent");
const { resolveCommandTargeting } = require("./commandTargeting");

// Danh mục lệnh dùng cho dashboard và autocomplete. Nội dung lấy từ
// helpContent.js để trợ giúp trong chat và dashboard không lệch nhau.
// `name` luôn là tên chính tắc; `aliases` là các tên cũ vẫn dùng được.
// `targeting` là phân loại đích do commandTargeting.js quyết định — dashboard
// dùng lại giá trị này thay vì giữ bản sao danh sách lệnh của riêng nó.
const definitions = HELP_COMMANDS.map((entry) => {
    const targeting = resolveCommandTargeting(entry.command);
    return {
        name: `/${entry.command}`,
        aliases: entry.aliases ? [...entry.aliases] : [],
        description: entry.description,
        category: entry.category,
        permission: entry.permission,
        usage: entry.usage,
        examples: (entry.examples || []).slice(),
        targeting: { mode: targeting.mode, reason: targeting.reason, broadcastScope: targeting.broadcastScope || null },
        arguments: []
    };
});

function getCommandRegistry() {
    return definitions.map((command) => ({
        ...command,
        aliases: [...command.aliases],
        examples: [...command.examples],
        targeting: { ...command.targeting },
        arguments: command.arguments.map((argument) => ({ ...argument }))
    }));
}

// Tìm theo tên chính tắc hoặc bí danh; trả về mục chính tắc.
function findCommand(name) {
    const canonical = resolveCommandName(name);
    if (!canonical) return null;
    return definitions.find((command) => command.name.slice(1) === canonical) || null;
}

module.exports = { findCommand, getCommandRegistry };
