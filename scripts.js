String.prototype.hash = function() {
    var hash = 0, i = 0, len = this.length;
    while ( i < len ) {
        hash  = ((hash << 5) - hash + this.charCodeAt(i++)) << 0;
    }
    return hash;
};

var lt = { // * top-level namespace
	
	init : function() 
	{
		let request = window.indexedDB.open('leitner', 1);
		request.onerror   = function() {console.log('Database failed to open'); };
		request.onsuccess = function() {console.log('Database opened successfully'); };

		// Setup the database tables if this has not already been done
		request.onupgradeneeded = function(e) 
		{
			let db = e.target.result;

			// table for card-answering events
			let store = db.createObjectStore('events', { keyPath: 'id', autoIncrement:true });

			// Define what data items the objectStore will contain
			store.createIndex('timestamp', 'timestamp', { unique: false });
			
			// -- target card (the correct answer in the case of MC)
			store.createIndex('card', 'card', { unique: false });
		
			// -- alternative 1 (in MC questions)
			store.createIndex('alt1', 'alt1', { unique: false });
			
			// -- alternative 2 (in MC questions)
  			store.createIndex('alt2', 'alt2', { unique: false });
  			
  			// -- result of the question (positive for correct, negative for incorrect)
			store.createIndex('result', 'result', { unique: false });

			console.log('Database setup complete.');
		};

	  	lt.db = request.result;
	  	
	},
	
	templates : { mc: $.templates("#mc") },
	
	sounds: {
		correct: new Audio('/sounds/correct.mp3'),
		incorrect: new Audio('/sounds/incorrect.wav')
	},
	
	decks : {},
	
	/**
	 * Takes a dictionary representing a deck, enriches it, and adds it to the set of 
	 * decks in the namespace.
	 */
	loadDeck : function(deck) 
	{
		deck.cards.forEach((card) => 
		{		
			console.log(card)
			// - generate (sufficiently) unique IDs for cards that don't
			//   have them
			if (!( 'id' in card))
				card.id = (card.f + card.b + '').hash()		
		});
		
		lt.decks[deck.name] = deck
	},

	
	// * sub-namespace for the current session
	session : {
	
		startSession : function(deck)
		{

			lt.session.deck = deck
			lt.session.generate();
		},
	
		generate : function() 
		{
			let deck = lt.session.deck
			$("article").empty();

			// generate a question
			// -- sample three cards. The first is the target, the other two provide false answers
			sample = _.sampleSize(deck.cards, 3);
			corr = _.sample([0, 1, 2]);

			$("article").html(
				lt.templates.mc.render({
					question: sample[corr].f,
					answer0: sample[0].b,
					answer1: sample[1].b,
					answer2: sample[2].b
				})
			)

			$("article ul#answers li button").on(
				'click',
				{ correct: corr },
				lt.session.processAnswer
			)            
		},
	
		processAnswer : function(e)
		{
			answered = $(e.target).data('answer')
			correct = e.data.correct

			if(answered == correct)
			{
				$('article').append('Correct!');
				lt.sounds.correct.play()
			
				$('article button').attr('disabled', true);
			
				setTimeout(lt.session.generate , 750)
			} else
			{
				$('article').append('Incorrect!');
				lt.sounds.incorrect.play()
			}
		},
	}
}

$(function() {

	// - init database
	// lt.init();

	// - load decks
	$.getJSON('./deck.json', lt.loadDeck)	
	.done(function(){
		lt.session.startSession(lt.decks['Hanzi'])
	});

;});