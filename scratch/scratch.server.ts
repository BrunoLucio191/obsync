type Names = "jose" | "malaquias";

type User = {
  name: string;
};

const processUserInDB = (someUser: Partial<User>) => {
  console.log(someUser);
};

const user1: Record<string, Names> = {
  name: "jose",
};

processUserInDB(user1);
