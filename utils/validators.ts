export const validateGroupId = (id) => /^grp-[a-zA-Z0-9-]+$/.test(id);
export const validateUserId = (id) => /^(user-)?[a-zA-Z0-9-]+$/.test(id);
