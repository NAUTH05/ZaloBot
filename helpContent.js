// Nguồn dữ liệu duy nhất cho trợ giúp (/help, /helpadmin) và cho
// danh mục lệnh hiển thị trên dashboard. Mọi cú pháp ở đây đã được đối chiếu
// với parser thật trong main.js.

const HELP_GROUPS = {
    PUBLIC: "public",
    ADMIN: "admin"
};

const CATEGORY = {
    START: "Bắt đầu",
    SCHEDULE: "Lịch học",
    NOTIFY: "Thông báo",
    UTILITY: "Tiện ích",
    HELP: "Trợ giúp",
    ACCESS: "Phân quyền",
    CHAT: "Quản lý chat",
    BROADCAST: "Thông báo chung",
    UPDATE: "Cập nhật",
    DIAGNOSTICS: "Kiểm tra hệ thống"
};

// Thứ tự khai báo quyết định thứ tự mục trong từng nhóm trợ giúp.
const HELP_COMMANDS = [
    // ---------------------------------------------------------------- công khai
    {
        command: "start",
        usage: "/start",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.START,
        permission: "user",
        description: "Xem hướng dẫn bắt đầu sử dụng trợ lý.",
        examples: ["/start"]
    },
    {
        command: "luumssv",
        aliases: ["find"],
        usage: "/luumssv [MSSV]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.START,
        permission: "user",
        description: "Lưu MSSV để dùng cho các lệnh lịch.",
        examples: ["/luumssv 123000xxx"],
        note: "Lệnh này chỉ lưu MSSV, không tự bật thông báo."
    },
    {
        command: "lich",
        usage: "/lich [MSSV]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.SCHEDULE,
        permission: "user",
        description: "Xem lịch học hôm nay.",
        examples: ["/lich", "/lich 123000xxx"],
        note: "Nếu không truyền MSSV, dùng MSSV đã lưu."
    },
    {
        command: "lichtuan",
        usage: "/lichtuan [MSSV]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.SCHEDULE,
        permission: "user",
        description: "Xem lịch học trong tuần.",
        examples: ["/lichtuan", "/lichtuan 123000xxx"],
        note: "Hiển thị lịch từ Thứ Hai đến Chủ Nhật."
    },
    {
        command: "lichthi",
        usage: "/lichthi [MSSV]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.SCHEDULE,
        permission: "user",
        description: "Xem lịch thi trong học kỳ.",
        examples: ["/lichthi", "/lichthi 123000xxx"],
        note: "Nếu không truyền MSSV, dùng MSSV đã lưu."
    },
    {
        command: "lichgv",
        usage: "/lichgv [Tên giảng viên]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.SCHEDULE,
        permission: "user",
        description: "Xem lịch dạy của giảng viên.",
        examples: ["/lichgv Nguyễn Minh Phúc"],
        note: "Nhập gần đúng họ tên, trợ lý chọn giảng viên khớp đầu tiên."
    },
    {
        command: "phongtrong",
        usage: "/phongtrong [Cơ sở]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.SCHEDULE,
        permission: "user",
        description: "Xem gợi ý phòng trống hôm nay.",
        examples: ["/phongtrong", "/phongtrong 1"],
        note: "Không truyền cơ sở thì mặc định là Cơ sở I."
    },
    {
        command: "nhanlich",
        aliases: ["dangky"],
        usage: "/nhanlich [MSSV] hh:mm homnay|homsau",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Bật nhận lịch học tự động vào giờ đã chọn, kèm lựa chọn lịch hôm nay hay hôm sau.",
        examples: ["/nhanlich 06:30 homnay", "/nhanlich 20:00 homsau", "/nhanlich 123000xxx 06:30 homnay"],
        note: "Bỏ qua MSSV nếu đã lưu bằng /luumssv. homnay = lịch hôm nay, homsau = lịch hôm sau. Giờ hợp lệ 00:00–23:59. Có thể đăng ký cùng một giờ cho cả hai ngày."
    },
    {
        command: "gionhanlich",
        aliases: ["danhsachdangky"],
        usage: "/gionhanlich",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Xem các mốc giờ nhận lịch đã lưu kèm ngày đích của từng mốc.",
        examples: ["/gionhanlich"]
    },
    {
        command: "suagionhanlich",
        aliases: ["suadangky"],
        usage: "/suagionhanlich ID hh:mm homnay|homsau",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Đổi giờ và ngày đích của một mốc nhận lịch đã lưu.",
        examples: ["/suagionhanlich 1 06:30 homnay", "/suagionhanlich 2 21:00 homsau", "/suagionhanlich 2 homsau"],
        note: "Đổi được cả giờ lẫn ngày đích; chỉ nhập homnay|homsau nếu chỉ muốn đổi ngày. Dùng /gionhanlich để xem ID."
    },
    {
        command: "xoagionhanlich",
        aliases: ["xoadangky"],
        usage: "/xoagionhanlich ID",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Xóa một mốc nhận lịch đã lưu.",
        examples: ["/xoagionhanlich 1"],
        note: "Dùng /gionhanlich để xem ID cần xóa."
    },
    {
        command: "tatnhanlich",
        aliases: ["huythongbao", "ngungnhanlich"],
        usage: "/tatnhanlich",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Tắt nhận lịch học tự động.",
        examples: ["/tatnhanlich"],
        note: "MSSV đã lưu vẫn dùng được với /lich và /lichtuan. Đừng nhầm với /tatnhaclich (tắt nhắc giờ bắt đầu tiết học)."
    },
    {
        command: "batnhaclich",
        usage: "/batnhaclich",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Bật nhắc giờ bắt đầu tiết học.",
        examples: ["/batnhaclich"],
        note: "Cần lưu MSSV bằng /luumssv trước."
    },
    {
        command: "tatnhaclich",
        usage: "/tatnhaclich",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Tắt nhắc giờ bắt đầu tiết học.",
        examples: ["/tatnhaclich"]
    },
    {
        command: "trangthainhaclich",
        usage: "/trangthainhaclich",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Xem trạng thái nhắc giờ bắt đầu tiết học.",
        examples: ["/trangthainhaclich"]
    },
    {
        command: "ai",
        usage: "/ai [Câu hỏi]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.UTILITY,
        permission: "user",
        description: "Hỏi trợ lý AI về lịch học đã lưu.",
        examples: ["/ai Tuần này tôi học môn gì?"],
        note: "Cần lưu MSSV bằng /luumssv trước."
    },
    {
        command: "time",
        usage: "/time",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.UTILITY,
        permission: "user",
        description: "Xem giờ hệ thống theo múi giờ Việt Nam.",
        examples: ["/time"]
    },
    {
        command: "myid",
        usage: "/myid",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.UTILITY,
        permission: "user",
        description: "Xem User ID và Chat ID của tài khoản hiện tại.",
        examples: ["/myid"]
    },
    {
        command: "help",
        usage: "/help",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.HELP,
        permission: "user",
        description: "Xem danh sách lệnh dành cho người dùng.",
        examples: ["/help"]
    },

    // ---------------------------------------------------------------- quản trị
    {
        command: "blockbot",
        usage: "/blockbot [User ID / Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.ACCESS,
        permission: "owner",
        description: "Chặn một tài khoản hoặc nhóm dùng bot.",
        examples: ["/blockbot 123456789"]
    },
    {
        command: "unblockbot",
        usage: "/unblockbot [User ID / Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.ACCESS,
        permission: "owner",
        description: "Bỏ chặn bot cho một tài khoản hoặc nhóm.",
        examples: ["/unblockbot 123456789"]
    },
    {
        command: "blockai",
        usage: "/blockai [User ID / Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.ACCESS,
        permission: "owner",
        description: "Chặn quyền dùng lệnh /ai.",
        examples: ["/blockai 123456789"]
    },
    {
        command: "unblockai",
        usage: "/unblockai [User ID / Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.ACCESS,
        permission: "owner",
        description: "Mở lại quyền dùng lệnh /ai.",
        examples: ["/unblockai 123456789"]
    },
    {
        command: "allowbot",
        usage: "/allowbot [User ID / Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.ACCESS,
        permission: "owner",
        description: "Thêm vào allowlist của bot.",
        examples: ["/allowbot 123456789"]
    },
    {
        command: "unallowbot",
        usage: "/unallowbot [User ID / Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.ACCESS,
        permission: "owner",
        description: "Xóa khỏi allowlist của bot.",
        examples: ["/unallowbot 123456789"]
    },
    {
        command: "allowai",
        usage: "/allowai [User ID / Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.ACCESS,
        permission: "owner",
        description: "Thêm vào allowlist của lệnh /ai.",
        examples: ["/allowai 123456789"]
    },
    {
        command: "unallowai",
        usage: "/unallowai [User ID / Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.ACCESS,
        permission: "owner",
        description: "Xóa khỏi allowlist của lệnh /ai.",
        examples: ["/unallowai 123456789"]
    },
    {
        command: "accessmode",
        usage: "/accessmode [bot|ai] [all|allowlist]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.ACCESS,
        permission: "owner",
        description: "Đổi chế độ truy cập cho bot hoặc lệnh /ai.",
        examples: ["/accessmode bot allowlist", "/accessmode ai all"]
    },
    {
        command: "accesslist",
        usage: "/accesslist",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.ACCESS,
        permission: "owner",
        description: "Xem toàn bộ danh sách chặn và allowlist.",
        examples: ["/accesslist"]
    },
    {
        command: "quanlychat",
        usage: "/quanlychat [Bộ lọc] [Trang]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.CHAT,
        permission: "owner",
        description: "Xem và lọc danh sách chat đã tương tác.",
        examples: ["/quanlychat", "/quanlychat active 1", "/quanlychat inactive 2"],
        note: "Bộ lọc: all, active, inactive, disabled, removed, private, group, unknown."
    },
    {
        command: "chitietchat",
        aliases: ["thongtinch"],
        usage: "/chitietchat [Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.CHAT,
        permission: "owner",
        description: "Xem chi tiết trạng thái và lỗi gửi của một chat.",
        examples: ["/chitietchat 123456789"]
    },
    {
        command: "tamdungchat",
        aliases: ["vohieuchat"],
        usage: "/tamdungchat [Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.CHAT,
        permission: "owner",
        description: "Tạm dừng gửi thông báo tới một chat.",
        examples: ["/tamdungchat 123456789"]
    },
    {
        command: "batlaichat",
        aliases: ["kichhoatchat"],
        usage: "/batlaichat [Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.CHAT,
        permission: "owner",
        description: "Bật lại một chat đã bị tạm dừng.",
        examples: ["/batlaichat 123456789"]
    },
    {
        command: "kiemtrachat",
        aliases: ["thuchatchat"],
        usage: "/kiemtrachat [Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.CHAT,
        permission: "owner",
        description: "Gửi tin kiểm tra để xác nhận chat còn nhận được thông báo.",
        examples: ["/kiemtrachat 123456789"]
    },
    {
        command: "xoachat",
        usage: "/xoachat [Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.CHAT,
        permission: "owner",
        description: "Xóa mềm một chat khỏi danh sách quản lý.",
        examples: ["/xoachat 123456789"],
        note: "Dữ liệu lịch sử vẫn được giữ lại."
    },
    {
        command: "chatfeature",
        usage: "/chatfeature [Chat ID] [schedule|broadcast] [on|off|auto]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.CHAT,
        permission: "owner",
        description: "Ghi đè tính năng thông báo cho một chat.",
        examples: ["/chatfeature 123456789 schedule off", "/chatfeature 123456789 broadcast auto"]
    },
    {
        command: "thongbao",
        usage: "/thongbao [Nội dung thông báo]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.BROADCAST,
        permission: "owner",
        description: "Gửi thông báo chung tới mọi chat đang hoạt động.",
        examples: ["/thongbao Hệ thống sẽ bảo trì lúc 22:00"],
        note: "Thông báo chung cho mọi chủ đề. Dùng /update khi nội dung là cập nhật sản phẩm hoặc bot."
    },
    {
        command: "update",
        usage: "/update [Nội dung cập nhật]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.UPDATE,
        permission: "owner",
        description: "Gửi thông báo cập nhật sản phẩm hoặc bot tới mọi chat đang hoạt động.",
        examples: ["/update Đã bổ sung tuỳ chọn giờ nhận lịch"],
        note: "Chỉ dùng cho thông tin cập nhật. Dùng /thongbao cho thông báo chung khác."
    },
    {
        command: "test6h",
        usage: "/test6h",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.DIAGNOSTICS,
        permission: "owner",
        description: "Chạy thử gửi lịch học theo mốc giờ đăng ký.",
        examples: ["/test6h"]
    },
    {
        command: "helpadmin",
        usage: "/helpadmin",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.HELP,
        permission: "owner",
        description: "Xem hướng dẫn các lệnh quản trị.",
        examples: ["/helpadmin"]
    }
];

// Bảng tra tên lệnh: tên chính tắc và mọi bí danh tương thích. Đây là nơi duy
// nhất quyết định tên cũ trỏ về lệnh nào, nên parser, phân loại đích của
// Command console và gợi ý gõ sai đều dùng chung một bảng.
const COMMAND_ALIASES = Object.freeze(
    HELP_COMMANDS.reduce((map, entry) => {
        map[entry.command] = entry.command;
        for (const alias of entry.aliases || []) map[alias] = entry.command;
        return map;
    }, {})
);

function resolveCommandName(value) {
    const name = String(value == null ? "" : value).replace(/^\//, "").trim().toLowerCase();
    if (!name) return "";
    return COMMAND_ALIASES[name] || name;
}

function aliasesFor(command) {
    const canonical = resolveCommandName(command);
    const entry = HELP_COMMANDS.find((item) => item.command === canonical);
    return entry?.aliases ? [...entry.aliases] : [];
}

function commandsInGroup(group) {
    return HELP_COMMANDS.filter((entry) => entry.group === group);
}

function findHelpCommand(name) {
    const needle = resolveCommandName(name);
    if (!needle) return null;
    return HELP_COMMANDS.find((entry) => entry.command === needle) || null;
}

function groupByCategory(entries) {
    const sections = new Map();
    for (const entry of entries) {
        if (!sections.has(entry.category)) sections.set(entry.category, []);
        sections.get(entry.category).push(entry);
    }
    return [...sections.entries()].map(([category, items]) => ({ category, items }));
}

// Mỗi lệnh là một khối gọn, thống nhất giữa /help và /helpadmin:
//   **/luumssv [MSSV]**
//   Lưu MSSV để dùng cho các lệnh lịch.
//   (Ví dụ: /luumssv 123000xxx)
//   (Lưu ý: ...)
// Khối được ngăn cách bằng dòng trống nên vẫn chia tin đúng theo sendMessage().
//
// Chỉ hiển thị TÊN CHÍNH TẮC. Bí danh vẫn nằm trong `aliases` và
// COMMAND_ALIASES để lệnh cũ tiếp tục chạy, nhưng không xuất hiện trong trợ
// giúp chat — tài liệu về tên cũ chỉ để trong README.
function renderCommand(entry) {
    const lines = [`**${entry.usage}**`];
    if (entry.description) lines.push(entry.description);
    const examples = (entry.examples || []).filter(Boolean);
    if (examples.length > 0) lines.push(`(Ví dụ: ${examples.join(", ")})`);
    if (entry.note) lines.push(`(Lưu ý: ${entry.note})`);
    return lines.join("\n");
}

function renderSections(entries) {
    return groupByCategory(entries)
        .map(({ category, items }) => `## {orange}${category.toUpperCase()}{/orange}\n\n${items.map(renderCommand).join("\n\n")}`)
        .join("\n\n");
}

function formatPublicHelp() {
    return `# {green}[ZALOBOT] HƯỚNG DẪN{/green}

> Dùng các lệnh bên dưới để tra cứu lịch học và nhận thông báo.

${renderSections(commandsInGroup(HELP_GROUPS.PUBLIC))}`;
}

function formatAdminHelp() {
    return `# {orange}[ADMIN] LỆNH QUẢN TRỊ{/orange}

> Chỉ tài khoản quản trị dùng được các lệnh bên dưới.

${renderSections(commandsInGroup(HELP_GROUPS.ADMIN))}`;
}

module.exports = {
    COMMAND_ALIASES,
    HELP_COMMANDS,
    HELP_GROUPS,
    aliasesFor,
    commandsInGroup,
    findHelpCommand,
    formatAdminHelp,
    formatPublicHelp,
    resolveCommandName
};
