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
    BIRTHDAY: "Sinh nhật",
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
        command: "find",
        usage: "/find [MSSV]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.START,
        permission: "user",
        description: "Lưu MSSV để dùng cho các lệnh lịch.",
        examples: ["/find 123000135"],
        note: "Lệnh này chỉ lưu MSSV, không tự bật thông báo."
    },
    {
        command: "lich",
        usage: "/lich [MSSV]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.SCHEDULE,
        permission: "user",
        description: "Xem lịch học hôm nay.",
        examples: ["/lich", "/lich 123000135"],
        note: "Nếu không truyền MSSV, dùng MSSV đã lưu."
    },
    {
        command: "lichtuan",
        usage: "/lichtuan [MSSV]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.SCHEDULE,
        permission: "user",
        description: "Xem lịch học trong tuần.",
        examples: ["/lichtuan", "/lichtuan 123000135"],
        note: "Hiển thị lịch từ Thứ Hai đến Chủ Nhật."
    },
    {
        command: "lichthi",
        usage: "/lichthi [MSSV]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.SCHEDULE,
        permission: "user",
        description: "Xem lịch thi trong học kỳ.",
        examples: ["/lichthi", "/lichthi 123000135"],
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
        command: "dangky",
        usage: "/dangky [MSSV] [hh:mm]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Bật nhận lịch học tự động theo giờ đã chọn.",
        examples: ["/dangky", "/dangky 123000135", "/dangky 06:30", "/dangky 123000135 06:30"],
        note: "Có thể dùng MSSV đã lưu hoặc truyền MSSV trực tiếp. Giờ hợp lệ từ 00:00 đến 23:59."
    },
    {
        command: "danhsachdangky",
        usage: "/danhsachdangky",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Xem các giờ nhận lịch đã lưu.",
        examples: ["/danhsachdangky"]
    },
    {
        command: "suadangky",
        usage: "/suadangky #ID [hh:mm]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Đổi một giờ nhận lịch đã lưu.",
        examples: ["/suadangky #1 20:00"],
        note: "Dùng /danhsachdangky để xem ID cần sửa."
    },
    {
        command: "xoadangky",
        usage: "/xoadangky #ID",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Xóa một giờ nhận lịch đã lưu.",
        examples: ["/xoadangky #1"],
        note: "Dùng /danhsachdangky để xem ID cần xóa."
    },
    {
        command: "huythongbao",
        usage: "/huythongbao",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Tắt nhận lịch học tự động.",
        examples: ["/huythongbao"],
        note: "MSSV đã lưu vẫn dùng được với /lich và /lichtuan."
    },
    {
        command: "batnhaclich",
        usage: "/batnhaclich",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.NOTIFY,
        permission: "user",
        description: "Bật nhắc giờ bắt đầu tiết học.",
        examples: ["/batnhaclich"],
        note: "Cần lưu MSSV bằng /find trước."
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
        command: "sinhnhat",
        usage: "/sinhnhat [Câu hỏi]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.BIRTHDAY,
        permission: "user",
        description: "Gửi câu hỏi cho phần hỏi đáp sinh nhật 27/08.",
        examples: ["/sinhnhat Điều bạn mong chờ nhất ở tuổi mới là gì?"],
        note: "Chỉ nhận câu hỏi trong ngày 27/08 theo giờ Việt Nam."
    },
    {
        command: "ai",
        usage: "/ai [Câu hỏi]",
        group: HELP_GROUPS.PUBLIC,
        category: CATEGORY.UTILITY,
        permission: "user",
        description: "Hỏi trợ lý AI về lịch học đã lưu.",
        examples: ["/ai Tuần này tôi học môn gì?"],
        note: "Cần lưu MSSV bằng /find trước."
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
        command: "thongtinch",
        usage: "/thongtinch [Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.CHAT,
        permission: "owner",
        description: "Xem chi tiết trạng thái và lỗi gửi của một chat.",
        examples: ["/thongtinch 123456789"]
    },
    {
        command: "vohieuchat",
        usage: "/vohieuchat [Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.CHAT,
        permission: "owner",
        description: "Tạm dừng gửi thông báo tới một chat.",
        examples: ["/vohieuchat 123456789"]
    },
    {
        command: "kichhoatchat",
        usage: "/kichhoatchat [Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.CHAT,
        permission: "owner",
        description: "Bật lại một chat đã bị tạm dừng.",
        examples: ["/kichhoatchat 123456789"]
    },
    {
        command: "thuchatchat",
        usage: "/thuchatchat [Chat ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.CHAT,
        permission: "owner",
        description: "Gửi tin kiểm tra để xác nhận chat còn nhận được thông báo.",
        examples: ["/thuchatchat 123456789"]
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
        usage: "/chatfeature [Chat ID] [schedule|birthday|broadcast] [on|off|auto]",
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
        command: "danhsach",
        usage: "/danhsach [Năm]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.BIRTHDAY,
        permission: "owner",
        description: "Xem danh sách câu hỏi sinh nhật.",
        examples: ["/danhsach", "/danhsach 2026"]
    },
    {
        command: "them",
        usage: "/them [Câu hỏi]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.BIRTHDAY,
        permission: "owner",
        description: "Thêm một câu hỏi sinh nhật thủ công.",
        examples: ["/them Điều bạn muốn hỏi tôi là gì?"]
    },
    {
        command: "sua",
        usage: "/sua [ID] [Câu hỏi mới]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.BIRTHDAY,
        permission: "owner",
        description: "Sửa nội dung một câu hỏi sinh nhật.",
        examples: ["/sua 1 Nội dung câu hỏi mới"]
    },
    {
        command: "xoa",
        usage: "/xoa [ID]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.BIRTHDAY,
        permission: "owner",
        description: "Xóa một câu hỏi sinh nhật.",
        examples: ["/xoa 1"]
    },
    {
        command: "traloi",
        usage: "/traloi [ID] [Câu trả lời]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.BIRTHDAY,
        permission: "owner",
        description: "Trả lời một câu hỏi sinh nhật.",
        examples: ["/traloi 1 Nội dung trả lời"]
    },
    {
        command: "congbo",
        usage: "/congbo [Năm]",
        group: HELP_GROUPS.ADMIN,
        category: CATEGORY.BIRTHDAY,
        permission: "owner",
        description: "Công bố hỏi đáp sinh nhật tới mọi chat.",
        examples: ["/congbo", "/congbo 2026"],
        note: "Bỏ trống năm để dùng năm hiện tại. Bản công bố không đổi sẽ không gửi trùng."
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

function commandsInGroup(group) {
    return HELP_COMMANDS.filter((entry) => entry.group === group);
}

function findHelpCommand(name) {
    const needle = String(name || "").replace(/^\//, "").toLowerCase();
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
//   **/find [MSSV]**
//   Lưu MSSV để dùng cho các lệnh lịch.
//   (Ví dụ: /find 123000135)
//   (Lưu ý: ...)
// Khối được ngăn cách bằng dòng trống nên vẫn chia tin đúng theo sendMessage().
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
    HELP_COMMANDS,
    HELP_GROUPS,
    commandsInGroup,
    findHelpCommand,
    formatAdminHelp,
    formatPublicHelp
};
