const test = require("node:test");
const assert = require("node:assert/strict");

const {
    BROADCAST_COMMANDS,
    PER_USER_COMMANDS,
    TARGETING,
    isBroadcastCommand,
    isPerUserCommand,
    normalizeCommandName,
    resolveCommandTargeting
} = require("../commandTargeting");
const { HELP_COMMANDS } = require("../helpContent");

test("lệnh theo từng người được phân loại đúng", () => {
    for (const name of ["find", "lich", "lichtuan", "dangky", "xoadangky", "huythongbao", "help"]) {
        assert.equal(resolveCommandTargeting(name).mode, TARGETING.PER_USER, `/${name} phải chạy theo từng người`);
        assert.equal(isPerUserCommand(name), true);
    }
});

test("lệnh broadcast được tách riêng và có giải thích phạm vi", () => {
    for (const name of BROADCAST_COMMANDS) {
        const result = resolveCommandTargeting(name);
        assert.equal(result.mode, TARGETING.BROADCAST, `/${name} phải là broadcast`);
        assert.ok(result.broadcastScope.includes("chỉ chạy đúng một lần"));
        assert.equal(isBroadcastCommand(name), true);
    }
    // Các lệnh gửi tới mọi chat phải nằm trong nhóm broadcast.
    for (const name of ["thongbao", "update", "congbocauhoi", "test6h"]) {
        assert.ok(BROADCAST_COMMANDS.has(name), `/${name} phải được coi là broadcast`);
    }
    // Tên cũ vẫn được phân loại y như tên chính tắc.
    assert.equal(resolveCommandTargeting("congbo").mode, TARGETING.BROADCAST);
});

test("lệnh toàn cục bị từ chối kèm lý do cụ thể", () => {
    const cases = [
        ["quanlychat", /chỉ liệt kê danh sách chat/],
        ["accessmode", /chế độ truy cập toàn hệ thống/],
        ["chitietchat", /Target Chat ID/],
        ["myid", /chính người gõ lệnh/],
        ["time", /chính người gõ lệnh/],
        ["helpadmin", /trợ giúp quản trị/]
    ];
    for (const [name, pattern] of cases) {
        const result = resolveCommandTargeting(name);
        assert.equal(result.mode, TARGETING.NONE, `/${name} không được chạy theo từng người`);
        assert.match(result.reason, pattern, `lý do của /${name} phải hữu ích`);
        assert.match(result.reason, new RegExp(`/${name}`));
    }
});

test("tên cũ được quy về tên chính tắc trước khi phân loại", () => {
    const pairs = [
        ["dangky", "nhanlich"],
        ["danhsachdangky", "gionhanlich"],
        ["suadangky", "suagionhanlich"],
        ["xoadangky", "xoagionhanlich"],
        ["huythongbao", "tatnhanlich"],
        ["find", "luumssv"],
        ["thongtinch", "chitietchat"],
        ["vohieuchat", "tamdungchat"],
        ["kichhoatchat", "batlaichat"],
        ["thuchatchat", "kiemtrachat"],
        ["danhsach", "danhsachcauhoi"],
        ["them", "themcauhoi"],
        ["sua", "suacauhoi"],
        ["xoa", "xoacauhoi"],
        ["traloi", "traloicauhoi"],
        ["congbo", "congbocauhoi"]
    ];
    for (const [alias, canonical] of pairs) {
        const aliasResult = resolveCommandTargeting(alias);
        const canonicalResult = resolveCommandTargeting(canonical);
        assert.equal(aliasResult.command, canonical, `/${alias} phải quy về /${canonical}`);
        assert.equal(aliasResult.mode, canonicalResult.mode, `/${alias} và /${canonical} phải cùng nhóm`);
    }
});

test("lệnh lạ hoặc rỗng mặc định bị từ chối (fail closed)", () => {
    const unknown = resolveCommandTargeting("khong-ton-tai");
    assert.equal(unknown.mode, TARGETING.NONE);
    assert.match(unknown.reason, /không nằm trong danh sách lệnh chạy theo từng người/);

    const empty = resolveCommandTargeting("");
    assert.equal(empty.mode, TARGETING.NONE);
    assert.match(empty.reason, /Thiếu tên lệnh/);

    assert.equal(resolveCommandTargeting(null).mode, TARGETING.NONE);
    assert.equal(resolveCommandTargeting(undefined).mode, TARGETING.NONE);
});

test("chấp nhận tên lệnh có hoặc không có dấu gạch chéo và khác hoa thường", () => {
    assert.equal(normalizeCommandName("/Help"), "help");
    assert.equal(normalizeCommandName("  HELP  "), "help");
    assert.equal(normalizeCommandName("/help"), "help");
    assert.equal(resolveCommandTargeting("/find").mode, TARGETING.PER_USER);
    assert.equal(resolveCommandTargeting("/ThongBao").mode, TARGETING.BROADCAST);
});

test("mọi lệnh trong trợ giúp đều được phân loại tường minh", () => {
    const { NOT_TARGETABLE_REASONS } = require("../commandTargeting");
    const missing = [];
    for (const entry of HELP_COMMANDS) {
        const result = resolveCommandTargeting(entry.command);
        // Mỗi lệnh phải rơi vào một nhóm rõ ràng, và lệnh bị từ chối phải có lý
        // do riêng thay vì thông báo chung chung.
        if (result.mode === TARGETING.NONE && !NOT_TARGETABLE_REASONS[entry.command]) {
            missing.push(entry.command);
        }
        if (result.mode !== TARGETING.NONE && result.reason) {
            missing.push(`${entry.command} (có lý do nhưng vẫn cho chọn)`);
        }
    }
    assert.deepEqual(missing, [], `các lệnh sau chưa được phân loại rõ: ${missing.join(", ")}`);
});

test("lệnh công khai chạy được theo từng người, trừ lệnh chỉ có nghĩa với người gõ", () => {
    const publicCommands = HELP_COMMANDS.filter((entry) => entry.group === "public").map((entry) => entry.command);
    const notTargetable = publicCommands.filter((name) => resolveCommandTargeting(name).mode === TARGETING.NONE);
    assert.deepEqual(notTargetable.sort(), ["myid", "time"]);
});

test("lệnh quản trị toàn cục không bao giờ chạy theo từng người", () => {
    const globalAdmin = ["blockbot", "unblockbot", "allowbot", "accesslist", "danhsach", "them", "traloi", "chatfeature"];
    for (const name of globalAdmin) {
        assert.equal(resolveCommandTargeting(name).mode, TARGETING.NONE, `/${name} phải bị từ chối khi chọn nhiều người`);
    }
});
