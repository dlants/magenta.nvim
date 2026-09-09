type Nested = {
  a: {
    b: {
      c: "test";
    };
  };
};

const val: Nested = {
  a: {
    b: {
      c: "test",
    },
  },
};

console.log(val.a.b.c);

val.a.b.d = "error";
