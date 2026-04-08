import { Request, Response, NextFunction } from 'express';
import { DB } from '../db';

export const checkGroupMembership = async (req: Request, res: Response, next: NextFunction) => {
  const { groupId } = req.params;
  const userId = req.user?.id;
  const [rows] = await DB.query(
    'SELECT role FROM mirror_group_members WHERE group_id=? AND user_id=?',
    [groupId, userId]
  );
  const member = (rows as any[])[0];
  if (!member) return res.status(403).json({error: 'Not a member'});
  (req as any).memberRole = member.role;
  next();
};
