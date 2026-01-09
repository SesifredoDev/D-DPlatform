export interface IUserBase {
  id: string;
  username: string;

}

export interface IUser extends IUserBase {
  email: string;
  profileIcon: string;
}
