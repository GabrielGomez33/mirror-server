export const checkGroupMembership = async (req, res, next) => {
  const { groupId } = req.params;
  const userId = req.user?.id;
  const db = global.db;
  const [member] = await db.query(
    'SELECT role FROM mirror_group_members WHERE group_id=? AND user_id=?',
    [groupId, userId]
  );
  if (!member) return res.status(403).json({error: 'Not a member'});
  req.memberRole = member.role;
  next();
};
