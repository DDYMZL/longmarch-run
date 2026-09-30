/**
 * 组织架构服务（Mock）
 *
 * 组织为多级树（mock/data.js ORGANIZATIONS，parentId 为空即顶级）。
 * 用户可选定任意层级节点作为所属组织，选定结果持久化到登录用户信息上。
 * 正式接入后端后，对应 /api/org/children、/api/org/mine、/api/org/select，页面调用方无需改动。
 */
const mockData = require('../mock/data');

const ORGANIZATIONS = mockData.ORGANIZATIONS;
const USER_KEY = 'lm_login_user'; // 与 services/auth.js 保持一致

/** 读取本地登录用户 */
function _readUser() {
  try {
    return wx.getStorageSync(USER_KEY) || null;
  } catch (e) {
    return null;
  }
}

/** 按 id 取组织原始节点 */
function getOrg(orgId) {
  for (let i = 0; i < ORGANIZATIONS.length; i++) {
    if (ORGANIZATIONS[i].id === orgId) return ORGANIZATIONS[i];
  }
  return null;
}

/**
 * 获取某层级的组织列表（parentId 传 null / 不传 返回顶级）。
 * 每项附带 hasChildren / childCount，供页面判断能否继续下钻。
 */
function getChildren(parentId) {
  const pid = parentId === undefined ? null : parentId;
  const list = ORGANIZATIONS.filter((o) => (o.parentId || null) === pid);
  list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  return list.map((o) => {
    const childCount = ORGANIZATIONS.filter((c) => c.parentId === o.id).length;
    return {
      id: o.id,
      name: o.name,
      parentId: o.parentId,
      level: o.level,
      hasChildren: childCount > 0,
      childCount: childCount
    };
  });
}

/** 顶级组织 */
function getRoots() {
  return getChildren(null);
}

/**
 * 回溯从顶级到该节点的完整路径（面包屑），返回 [{id, name}]
 */
function getPath(orgId) {
  const path = [];
  let cur = getOrg(orgId);
  let guard = 0;
  while (cur && guard < 32) {
    path.unshift({ id: cur.id, name: cur.name });
    cur = cur.parentId ? getOrg(cur.parentId) : null;
    guard++;
  }
  return path;
}

/** 组织全路径名，如「长征集团总部 / 华东分公司 / 技术部」 */
function getFullName(orgId) {
  return getPath(orgId)
    .map((p) => p.name)
    .join(' / ');
}

/**
 * 获取用户所属组织信息（未选择时 orgId 为 null）
 * @param {object} [user] 传入则用之，否则读本地登录用户
 */
function getUserOrg(user) {
  const u = user || _readUser();
  if (!u || !u.orgId) {
    return { orgId: null, orgName: '', fullName: '', path: [] };
  }
  const path = getPath(u.orgId);
  return {
    orgId: u.orgId,
    orgName: path.length ? path[path.length - 1].name : '',
    fullName: path.map((p) => p.name).join(' / '),
    path: path
  };
}

/**
 * 选定 / 修改用户所属组织，持久化到登录用户信息，返回更新后的 user
 * @param {number} orgId
 */
function setUserOrg(orgId) {
  const user = _readUser() || {};
  const org = getOrg(orgId);
  if (!org) return user;
  const path = getPath(orgId);
  user.orgId = orgId;
  user.orgName = org.name;
  user.orgFullName = path.map((p) => p.name).join(' / ');
  try {
    wx.setStorageSync(USER_KEY, user);
  } catch (e) {
    // 忽略持久化异常，仍返回内存中的 user
  }
  return user;
}

module.exports = {
  getOrg,
  getChildren,
  getRoots,
  getPath,
  getFullName,
  getUserOrg,
  setUserOrg
};
