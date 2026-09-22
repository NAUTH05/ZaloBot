const { HELP_COMMANDS } = require("./helpContent");

// Danh mục lệnh dùng cho dashboard và autocomplete. Nội dung lấy từ
// helpContent.js để trợ giúp trong chat và dashboard không lệch nhau.
const definitions = HELP_COMMANDS.map((entry) => ({
    name: `/${entry.command}`,
    aliases: entry.aliases ? [...entry.aliases] : [],
    description: entry.description,
    category: entry.category,
    permission: entry.permission,
    usage: entry.usage,
    examples: (entry.examples || []).slice(),
    arguments: []
}));

function getCommandRegistry() { return definitions.map((command) => ({ ...command, aliases: [...command.aliases], examples: [...command.examples], arguments: command.arguments.map((argument) => ({ ...argument })) })); }
function findCommand(name) { const needle = String(name || "").replace(/^\//, "").toLowerCase(); return definitions.find((command) => command.name.slice(1) === needle || command.aliases.includes(needle)) || null; }

module.exports = { findCommand, getCommandRegistry };
