export const validateGroupId = (id: string) => /^grp-[a-zA-Z0-9-]+$/.test(id);
export const validateUserId = (id: string) => /^(user-)?[a-zA-Z0-9-]+$/.test(id);
